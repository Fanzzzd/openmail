import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Deferred, Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@openmail/core", () => import("../../../../../packages/core/src/index.js"));
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp") },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  session: {},
}));

import { DeviceError } from "../../../../../packages/core/src/domain/errors.js";
import {
  DEFAULT_PREFS,
  type AttachmentSaveFolder,
} from "../../../../../packages/core/src/domain/prefs.js";
import type { DownloadItem } from "../../shared/downloads";
import { activeDownload, downloadsProgress } from "../../shared/downloads";
import { attachmentFolder } from "./attachment-actions";
import { createDownloads, writeUnique, type DownloadDeps } from "./downloads";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "om-downloads-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const text = (value: string) => new TextEncoder().encode(value);
const setup = (overrides: Partial<DownloadDeps> = {}) => {
  const pending: Promise<void>[] = [];
  const events: (readonly DownloadItem[])[] = [];
  const deps: DownloadDeps = {
    fetch: (source) =>
      Effect.succeed({
        filename: source.filename,
        mimeType: "text/plain",
        data: text(`content of ${source.filename}`),
      }),
    blocked: ({ filename }) => filename.endsWith(".command"),
    quarantine: vi.fn(() => Effect.void),
    openPath: vi.fn(() => Promise.resolve("")),
    showItem: vi.fn(),
    run: (effect) => {
      pending.push(Effect.runPromise(effect));
    },
    ...overrides,
  };
  const list = createDownloads(deps);
  list.subscribe((items) => events.push(items));
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  return { list, deps, events, settle };
};
const source = (filename: string, size = 10) => ({
  messageId: "account/message",
  path: [0],
  filename,
  size,
});

it("collisions get browser-style names and never overwrite, including the extensionless case", async () => {
  await writeFile(path.join(folder, "report.pdf"), "keep");
  await writeFile(path.join(folder, "report (2).pdf"), "keep 2");
  expect(path.basename(await writeUnique(folder, "report.pdf", text("new")))).toBe(
    "report (3).pdf",
  );
  expect(path.basename(await writeUnique(folder, "README", text("a")))).toBe("README");
  expect(path.basename(await writeUnique(folder, "README", text("b")))).toBe("README (2)");
  expect(await readFile(path.join(folder, "report.pdf"), "utf8")).toBe("keep");
  expect(await readFile(path.join(folder, "report (3).pdf"), "utf8")).toBe("new");
});

it("a save lands in the folder with no dialog, is quarantined, and reports progress then done", async () => {
  const { list, deps, events, settle } = setup({ chunkBytes: 4, progressMs: 0 });
  expect(list.start([source("notes.txt", 22)], folder)).toBe(1);
  expect(list.list()).toMatchObject([{ filename: "notes.txt", received: 0 }]);
  expect(list.list().every(activeDownload)).toBe(true);
  await settle();
  const [item] = list.list();
  expect(item).toMatchObject({ filename: "notes.txt", status: "done", blocked: false });
  expect(await readFile(path.join(folder, "notes.txt"), "utf8")).toBe("content of notes.txt");
  expect(deps.quarantine).toHaveBeenCalledWith(path.join(folder, "notes.txt"));
  const received = events.map((items) => items[0]?.received ?? 0);
  expect(received.some((bytes) => bytes > 0 && bytes < 20)).toBe(true);
  expect(received).toEqual(received.toSorted((a, b) => a - b));
  expect(events.map((items) => items[0]?.status)).toContain("writing");
});

it("progress events are coalesced to the interval", async () => {
  let clock = 0;
  const { list, events, settle } = setup({ chunkBytes: 1, progressMs: 1000, now: () => clock });
  list.start([source("tiny.txt")], folder);
  await settle();
  // Queued, writing, done: one byte at a time adds no extra events while the clock stands still.
  expect(events.length).toBeLessThanOrEqual(4);
  clock = 5000;
  expect(downloadsProgress(list.list())).toBeNull();
});

it("two saves of one name in one batch both land, as name and name (2)", async () => {
  const { list, settle } = setup();
  list.start([source("same.txt"), source("same.txt")], folder);
  await settle();
  expect((await readdir(folder)).toSorted()).toEqual(["same (2).txt", "same.txt"]);
  expect(
    list
      .list()
      .map((item) => item.filename)
      .toSorted(),
  ).toEqual(["same (2).txt", "same.txt"]);
});

it("a fetch failure is a category, not a message, and retry downloads it again", async () => {
  let fail = true;
  const { list, settle } = setup({
    fetch: (from) =>
      fail
        ? Effect.fail(new DeviceError({ message: "token=secret provider text" }))
        : Effect.succeed({ filename: from.filename, mimeType: "text/plain", data: text("ok") }),
  });
  list.start([source("later.txt")], folder);
  await settle();
  const [failed] = list.list();
  expect(failed).toMatchObject({ status: "failed", failure: "fetch" });
  expect(JSON.stringify(failed)).not.toContain("secret");
  fail = false;
  await Effect.runPromise(list.command(failed?.id ?? "", "retry"));
  expect(list.list().every(activeDownload)).toBe(true);
  await settle();
  expect(list.list()[0]).toMatchObject({ status: "done", filename: "later.txt" });
  expect(list.list()[0]).not.toHaveProperty("failure");
  expect(await readFile(path.join(folder, "later.txt"), "utf8")).toBe("ok");
  const done = await Effect.runPromise(
    Effect.flip(list.command(list.list()[0]?.id ?? "", "retry")),
  );
  expect(done.message).toContain("Only failed");
});

it("a write failure marks the row failed and leaves no partial file", async () => {
  const { list, settle } = setup();
  list.start([source("x.txt")], path.join(folder, "missing", "folder"));
  await settle();
  expect(list.list()[0]).toMatchObject({ status: "failed", failure: "write" });
  expect(await readdir(folder)).toEqual([]);
});

it("blocked types still save but never open; Show in Finder works for them", async () => {
  const { list, deps, settle } = setup();
  list.start([source("run.command")], folder);
  await settle();
  const [item] = list.list();
  expect(item).toMatchObject({ status: "done", blocked: true });
  const error = await Effect.runPromise(Effect.flip(list.command(item?.id ?? "", "open")));
  expect(error.message).toContain("run.command");
  expect(deps.openPath).not.toHaveBeenCalled();
  await Effect.runPromise(list.command(item?.id ?? "", "show"));
  expect(deps.showItem).toHaveBeenCalledWith(path.join(folder, "run.command"));
});

it("open reports OS errors, and a moved file is marked missing and can be fetched again", async () => {
  const { list, deps, settle } = setup();
  list.start([source("a.txt")], folder);
  await settle();
  const id = list.list()[0]?.id ?? "";
  await Effect.runPromise(list.command(id, "open"));
  expect(deps.openPath).toHaveBeenCalledWith(path.join(folder, "a.txt"));
  vi.mocked(deps.openPath).mockResolvedValueOnce("No application");
  expect((await Effect.runPromise(Effect.flip(list.command(id, "open")))).message).toBe(
    "No application",
  );
  await rm(path.join(folder, "a.txt"));
  await Effect.runPromise(Effect.flip(list.command(id, "show")));
  expect(list.list()[0]?.failure).toBe("missing");
  await Effect.runPromise(list.command(id, "retry"));
  await settle();
  expect(list.list()[0]).toMatchObject({ status: "done" });
  expect(await readdir(folder)).toEqual(["a.txt"]);
});

it("remove and clear keep active downloads, and late results of removed rows are dropped", async () => {
  const gate = Effect.runSync(Deferred.make<void>());
  const { list, settle } = setup({
    fetch: (from) =>
      from.filename === "slow.txt"
        ? Deferred.await(gate).pipe(
            Effect.as({ filename: from.filename, mimeType: "text/plain", data: text("s") }),
          )
        : Effect.succeed({ filename: from.filename, mimeType: "text/plain", data: text("f") }),
  });
  list.start([source("fast.txt")], folder);
  list.start([source("slow.txt")], folder);
  await vi.waitFor(() => expect(list.list()[1]?.status).toBe("done"));
  const slow = list.list()[0];
  expect(slow?.status).toBe("fetching");
  await Effect.runPromise(list.command(slow?.id ?? "", "remove"));
  expect(list.list()).toHaveLength(2);
  list.clear();
  expect(list.list().map((item) => item.filename)).toEqual(["slow.txt"]);
  Effect.runSync(Deferred.succeed(gate, undefined));
  await settle();
  list.clear();
  expect(list.list()).toEqual([]);
  expect((await Effect.runPromise(Effect.flip(list.command(slow?.id ?? "", "open")))).message).toBe(
    "No download",
  );
});

it("the overall ring shows bytes over known sizes of active downloads only", () => {
  const base = { filename: "f", blocked: false, startedAt: 0 } as const;
  expect(
    downloadsProgress([
      { ...base, id: "1", size: 100, received: 50, status: "writing" },
      { ...base, id: "2", size: 100, received: 0, status: "fetching" },
      { ...base, id: "3", size: 100, received: 100, status: "done" },
    ]),
  ).toBe(0.25);
  expect(
    downloadsProgress([{ ...base, id: "1", size: 0, received: 0, status: "fetching" }]),
  ).toBeNull();
});

it("the attachment folder follows the setting; legacy ask means Downloads, relative paths fail", async () => {
  // No stored setting means the key is absent, as in a profile from before the setting existed.
  const { attachmentSaveFolder: _default, ...unset } = DEFAULT_PREFS;
  const prefs = (attachmentSaveFolder?: AttachmentSaveFolder) => ({
    prefs: Effect.succeed(attachmentSaveFolder ? { ...unset, attachmentSaveFolder } : unset),
  });
  const custom = path.join(folder, "nested", "attachments");
  expect(
    await Effect.runPromise(attachmentFolder(prefs({ kind: "custom", path: custom }), "/dl")),
  ).toBe(custom);
  expect((await readdir(path.join(folder, "nested"))).length).toBe(1);
  expect(await Effect.runPromise(attachmentFolder(prefs({ kind: "ask" }), folder))).toBe(folder);
  expect(await Effect.runPromise(attachmentFolder(prefs(undefined), folder))).toBe(folder);
  const error = await Effect.runPromise(
    Effect.flip(attachmentFolder(prefs({ kind: "custom", path: "relative/dir" }), folder)),
  );
  expect(error.message).toContain("absolute");
});
