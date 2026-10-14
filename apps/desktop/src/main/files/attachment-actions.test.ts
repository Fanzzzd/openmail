import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  mkdir,
  writeFile,
  utimes,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Fiber } from "effect";
import { constVoid } from "effect/Function";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Mailbox } from "../../../../../packages/core/src/mailbox/mailbox.js";
import { buildMime } from "../../../../../packages/core/src/platform/node/compose.js";
import { fakeServer, TestMailbox } from "../../../../../packages/core/src/platform/node/testing.js";
import type { IncomingMessage } from "../../../../../packages/core/src/domain/message.js";

const native = vi.hoisted(() => ({
  preview: vi.fn(),
  drag: vi.fn(),
  share: vi.fn(),
  popup: vi.fn(),
  copy: vi.fn(),
  open: vi.fn(),
  apps: vi.fn(),
  openWith: vi.fn(),
  parentDestroyed: false,
  failFile: "",
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: (...args: Parameters<typeof fs.writeFile>) => {
      if (native.failFile && typeof args[0] === "string" && args[0].endsWith(native.failFile))
        return Promise.reject(new Error("Fixture disk failure"));
      return fs.writeFile(...args);
    },
    open: (...args: Parameters<typeof fs.open>) => {
      if (native.failFile && typeof args[0] === "string" && args[0].endsWith(native.failFile))
        return Promise.reject(new Error("Fixture disk failure"));
      return fs.open(...args);
    },
  };
});
vi.mock("@openmail/core", () => import("../../../../../packages/core/src/index.js"));
vi.mock("./attachment-apps", () => ({
  registeredAttachmentApps: native.apps,
  openAttachmentWith: native.openWith,
  attachmentAppLabels: (apps: readonly string[]) => apps.map((app) => path.basename(app, ".app")),
}));
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), once: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: class {
    once = vi.fn();
    previewFile = native.preview;
    webContents = { startDrag: native.drag };
    isDestroyed() {
      return native.parentDestroyed;
    }
  },
  ShareMenu: class {
    constructor(options: unknown) {
      native.share(options);
    }
    popup = native.popup;
  },
  ClipboardItem: class {
    constructor(readonly items: Record<string, string>) {}
  },
  clipboard: { write: native.copy },
  nativeImage: { createFromDataURL: () => ({ width: 1, height: 1 }) },
  shell: { openPath: native.open },
  session: {},
}));
import { app, BrowserWindow, dialog } from "electron";
import {
  attachmentAction,
  attachmentApps,
  prepareAttachmentDrag,
  saveAttachmentsTo,
} from "./attachment-actions";
import { createDownloads, type Downloads } from "./downloads";
import {
  AttachmentTemp,
  attachmentTemp,
  cleanupAttachmentTemps,
  cleanupPrintTemps,
} from "./attachment-temp";

let folder: string;
beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "om-native-files-"));
  vi.mocked(app).getPath.mockReturnValue(folder);
});
afterAll(async () => {
  await attachmentTemp(app).dispose();
  await rm(folder, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  native.parentDestroyed = false;
  native.failFile = "";
  native.open.mockResolvedValue("");
  native.apps.mockReturnValue(
    Effect.succeed(["/Applications/First.app", "/Applications/Second.app"]),
  );
  native.openWith.mockReturnValue(Effect.void);
  native.copy.mockResolvedValue(undefined);
});
/** A downloads list that runs saves against the test mailbox; `settle` waits for every write. */
const downloadsFor = (m: Mailbox["Service"]) => {
  const pending: Promise<void>[] = [];
  const list = createDownloads({
    fetch: (source) => m.reading.attachmentPart(source.messageId, source.path),
    blocked: ({ filename }) => /\.(command|webloc)$/.test(filename),
    quarantine: () => Effect.void,
    openPath: native.open,
    showItem: vi.fn(),
    run: (effect) => {
      pending.push(Effect.runPromise(effect));
    },
  });
  const settle = Effect.promise(async () => {
    while (pending.length) await pending.shift();
  });
  return { list, settle };
};
const noDownloads: Downloads = createDownloads({
  fetch: () => Effect.die("unused"),
  blocked: () => false,
  quarantine: () => Effect.void,
  openPath: native.open,
  showItem: vi.fn(),
  run: constVoid,
});
const original: IncomingMessage = {
  providerId: "files",
  threadId: "thread",
  subject: "Files",
  from: { name: "A", address: "a@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText: "",
  bodyHtml: "",
  labels: ["INBOX"],
  isUnread: false,
  isStarred: false,
  attachments: [
    { filename: "../../same.txt", mimeType: "text/plain", size: 3 },
    { filename: "../../same.txt", mimeType: "text/plain", size: 3 },
    { filename: "run.command", mimeType: "application/octet-stream", size: 2 },
  ],
};
const withFiles = async (
  f: (m: Mailbox["Service"], id: string, parent: BrowserWindow) => Effect.Effect<void, unknown>,
  thirdFilename = "run.command",
) => {
  const input = {
    ...original,
    attachments: original.attachments.map((file, index) =>
      index === 2 ? { ...file, filename: thirdFilename } : file,
    ),
  };
  const server = fakeServer("me@example.com", [input]);
  server.raw.set(
    "files",
    await Effect.runPromise(
      buildMime(original.from, {
        to: [],
        cc: [],
        bcc: [],
        subject: "Files",
        text: "",
        attachments: input.attachments.map((a, i) => ({
          ...a,
          content: Buffer.from(["one", "two", "sh"][i] ?? "").toString("base64"),
        })),
      }),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({
        provider: "imap",
        input: {
          preset: "custom",
          email: server.email,
          password: "pw",
          imapHost: "imap.example.com",
          imapPort: 993,
          smtpHost: "smtp.example.com",
          smtpPort: 465,
        },
      });
      yield* m.sync();
      yield* f(m, `${account.id}/files`, new BrowserWindow());
    }).pipe(Effect.provide(TestMailbox({ imap: server }))),
  );
};

it("dot-only attachment filenames save into the attachment folder without a dialog", async () => {
  const output = await mkdtemp(path.join(folder, "dot-save-"));
  await withFiles(
    (m, id, parent) =>
      Effect.gen(function* () {
        yield* m.app.setPrefs({ attachmentSaveFolder: { kind: "custom", path: output } });
        const { list, settle } = downloadsFor(m);
        expect((yield* m.reading.attachmentPart(id, [2])).filename).toBe(" .. ");
        expect(
          yield* attachmentAction(m, parent, { messageId: id, paths: [[2]], action: "save" }, list),
        ).toEqual({ count: 1, failures: [] });
        yield* settle;
        expect(list.list()).toMatchObject([{ filename: "attachment", status: "done" }]);
      }),
    " .. ",
  );
  expect(vi.mocked(dialog).showOpenDialog.mock.calls).toHaveLength(0);
  expect(await readdir(output)).toEqual(["attachment"]);
  expect(await readFile(path.join(output, "attachment"), "utf8")).toBe("sh");
});

it("dot-only attachment filenames produce a private temp file before drag-out", async () => {
  await withFiles(
    (m, id, parent) =>
      Effect.gen(function* () {
        expect((yield* m.reading.attachmentPart(id, [2])).filename).toBe(" .. ");
        yield* prepareAttachmentDrag(m, parent, { messageId: id, paths: [[2]] });
        expect(
          yield* attachmentAction(
            m,
            parent,
            { messageId: id, paths: [[2]], action: "drag" },
            noDownloads,
          ),
        ).toEqual({ count: 1, failures: [] });
        const drag: unknown = native.drag.mock.calls[0]?.[0];
        const file = drag && typeof drag === "object" && "file" in drag ? drag.file : undefined;
        if (typeof file !== "string") throw new Error("No drag-out file");
        expect(path.basename(file)).toBe("attachment");
        expect(path.dirname(file)).toContain("openmail-attachments-");
        expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("sh");
      }),
    " .. ",
  );
});

it("Quick Look previews a private 0600 file; non-macOS and preview errors open the default app", async () => {
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      yield* attachmentAction(
        m,
        parent,
        { messageId: id, paths: [[0]], action: "preview" },
        noDownloads,
      );
      const file: unknown =
        process.platform === "darwin"
          ? native.preview.mock.calls[0]?.[0]
          : native.open.mock.calls[0]?.[0];
      expect(typeof file).toBe("string");
      if (typeof file !== "string") throw new Error("No preview file");
      expect(path.basename(file)).toBe("same.txt");
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("one");
      expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
      expect((yield* Effect.promise(() => stat(path.dirname(file)))).mode & 0o777).toBe(0o700);
      if (process.platform === "darwin") {
        expect(native.open).not.toHaveBeenCalled();
        native.preview.mockImplementationOnce(() => {
          throw new Error("No Quick Look");
        });
        yield* attachmentAction(
          m,
          parent,
          { messageId: id, paths: [[1]], action: "preview" },
          noDownloads,
        );
        expect(native.open).toHaveBeenCalledTimes(1);
      }
    }),
  );
});
it("multi-copy writes native file URIs; drag uses prepared files without another provider fetch", async () => {
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      const paths = [[0], [1]];
      yield* attachmentAction(m, parent, { messageId: id, paths, action: "copy" }, noDownloads);
      const items: unknown = native.copy.mock.calls[0]?.[0];
      expect(Array.isArray(items)).toBe(true);
      if (!Array.isArray(items)) throw new Error("No clipboard files");
      const item: unknown = items[0];
      if (
        !item ||
        typeof item !== "object" ||
        !("items" in item) ||
        !item.items ||
        typeof item.items !== "object" ||
        !("text/uri-list" in item.items) ||
        typeof item.items["text/uri-list"] !== "string"
      )
        throw new Error("No native file URI list");
      const files = item.items["text/uri-list"].split("\r\n").map((url) => fileURLToPath(url));
      expect(files.length).toBe(2);
      expect(files[0]).not.toBe(files[1]);
      expect(
        yield* Effect.promise(() => Promise.all(files.map((file) => readFile(file, "utf8")))),
      ).toEqual(["one", "two"]);
      expect(
        (yield* attachmentAction(
          m,
          parent,
          { messageId: id, paths, action: "drag" },
          noDownloads,
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* prepareAttachmentDrag(m, parent, { messageId: id, paths });
      const fetch = vi.spyOn(m.reading, "attachmentParts");
      expect(
        yield* attachmentAction(m, parent, { messageId: id, paths, action: "drag" }, noDownloads),
      ).toEqual({
        count: 2,
        failures: [],
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(native.drag).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.arrayContaining([expect.stringContaining("same.txt")]),
        }),
      );
      expect(
        (yield* attachmentAction(
          m,
          parent,
          { messageId: id, paths: [[0]], action: "drag" },
          noDownloads,
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
      native.parentDestroyed = true;
      expect(
        (yield* attachmentAction(
          m,
          parent,
          { messageId: id, paths, action: "drag" },
          noDownloads,
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  );
});
it("a slow previous selection cannot replace the latest prepared drag", async () => {
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      const original = m.reading.attachmentParts.bind(m);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      vi.spyOn(m.reading, "attachmentParts").mockImplementation((messageId, target) =>
        original(messageId, target).pipe(
          Effect.tap(() =>
            target[0]?.[0] === 0
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          ),
        ),
      );
      const older = yield* prepareAttachmentDrag(m, parent, { messageId: id, paths: [[0]] }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* prepareAttachmentDrag(m, parent, { messageId: id, paths: [[1]] });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(older);
      expect(
        yield* attachmentAction(
          m,
          parent,
          { messageId: id, paths: [[1]], action: "drag" },
          noDownloads,
        ),
      ).toEqual({ count: 1, failures: [] });
    }),
  );
});
it("Save To asks for a folder, keeps duplicate filenames, and cancel fetches nothing", async () => {
  const destination = path.join(folder, "saved");
  await mkdir(destination, { recursive: true });
  vi.mocked(dialog)
    .showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    .mockResolvedValueOnce({ canceled: false, filePaths: [destination] });
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      const { list, settle } = downloadsFor(m);
      const fetch = vi.spyOn(m.reading, "attachmentPart");
      const request = { messageId: id, paths: [[0], [1]] };
      expect(yield* saveAttachmentsTo(m, list, parent, request)).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(list.list()).toEqual([]);
      expect(yield* saveAttachmentsTo(m, list, parent, request)).toBe(2);
      yield* settle;
      expect(list.list().map((item) => item.status)).toEqual(["done", "done"]);
    }),
  );
  expect((await readdir(destination)).toSorted()).toEqual(["same (2).txt", "same.txt"]);
  const contents = await Promise.all(
    ["same.txt", "same (2).txt"].map((name) => readFile(path.join(destination, name), "utf8")),
  );
  expect(contents.toSorted()).toEqual(["one", "two"]);
});
it("share routes resolved files to ShareMenu on macOS", async () => {
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      const result = yield* attachmentAction(
        m,
        parent,
        {
          messageId: id,
          paths: [[0], [1]],
          action: "share",
        },
        noDownloads,
      ).pipe(Effect.result);
      if (process.platform === "darwin") {
        expect(result._tag).toBe("Success");
        expect(native.share).toHaveBeenCalledWith({
          filePaths: [expect.stringContaining("same.txt"), expect.stringContaining("same.txt")],
        });
        expect(native.popup).toHaveBeenCalledWith({ window: parent });
      } else expect(result._tag).toBe("Failure");
    }),
  );
});
it("all preview/open paths preserve the executable block and report shell failures", async () => {
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      for (const action of ["open", "preview"] as const)
        expect(
          (yield* attachmentAction(
            m,
            parent,
            { messageId: id, paths: [[2]], action },
            noDownloads,
          ).pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect(native.open).not.toHaveBeenCalled();
      expect(native.preview).not.toHaveBeenCalled();
      native.open.mockResolvedValueOnce("Cannot open file");
      expect(
        (yield* attachmentAction(
          m,
          parent,
          { messageId: id, paths: [[0]], action: "open" },
          noDownloads,
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  );
});
it("temp storage expires and cleans up its directory; failed writes leave no partial files", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const store = new AttachmentTemp(folder, 5);
  const removal = vi.spyOn(store, "remove");
  try {
    const files = await store.write([
      { filename: "../../private.txt", data: Buffer.from("private") },
    ]);
    const file = files[0];
    if (!file) throw new Error("No temp file");
    const root = path.dirname(path.dirname(path.dirname(file)));
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    await vi.advanceTimersByTimeAsync(4);
    expect(removal).not.toHaveBeenCalled();
    expect((await stat(file)).isFile()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(removal).toHaveBeenCalledTimes(1);
    // The timer starts asynchronous filesystem work. Wait for that work, too.
    const expired = removal.mock.results[0];
    if (expired?.type !== "return") throw new Error("Expiry did not remove the batch");
    await expired.value;
    await expect(stat(file)).rejects.toThrow();
    const long = await store.writeBatch([
      { filename: `${"x".repeat(300)}.txt`, data: Buffer.from("x") },
    ]);
    expect(Buffer.byteLength(path.basename(long.files[0] ?? ""))).toBeLessThanOrEqual(200);
    await store.remove(long);
    expect(await readdir(root)).toEqual([]);
  } finally {
    try {
      await store.dispose();
    } finally {
      removal.mockRestore();
      vi.useRealTimers();
    }
  }
});

it("replacing a prepared batch removes old files immediately and separates attachment lists", async () => {
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      const outer = { messageId: id, paths: [[0]], listId: "outer" };
      const inner = { messageId: id, paths: [[0]], listId: "embedded" };
      yield* prepareAttachmentDrag(m, parent, outer);
      yield* attachmentAction(m, parent, { ...outer, action: "drag" }, noDownloads);
      const old: unknown = native.drag.mock.calls.at(-1)?.[0];
      if (!old || typeof old !== "object" || !("file" in old) || typeof old.file !== "string")
        throw new Error("No drag file");
      const oldFile = old.file;
      yield* prepareAttachmentDrag(m, parent, { ...outer, paths: [[1]] });
      expect(
        yield* Effect.promise(() =>
          stat(oldFile).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
      yield* prepareAttachmentDrag(m, parent, inner);
      expect(
        (yield* attachmentAction(
          m,
          parent,
          { ...outer, paths: [[1]], action: "drag" },
          noDownloads,
        ).pipe(Effect.result))._tag,
      ).toBe("Success");
    }),
  );
});

it("save all continues after a disk failure, marks that download failed, and retries it", async () => {
  const destination = path.join(folder, "partial-save");
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      yield* m.app.setPrefs({ attachmentSaveFolder: { kind: "custom", path: destination } });
      const { list, settle } = downloadsFor(m);
      native.failFile = "/same.txt";
      const result = yield* attachmentAction(
        m,
        parent,
        { messageId: id, paths: [[0], [2]], action: "save" },
        list,
      );
      yield* settle;
      native.failFile = "";
      expect(result).toEqual({ count: 2, failures: [] });
      const failed = list.list().find((item) => item.status === "failed");
      expect(failed).toMatchObject({ filename: "same.txt", failure: "write" });
      expect(list.list().find((item) => item.filename === "run.command")).toMatchObject({
        status: "done",
        blocked: true,
      });
      yield* list.command(failed?.id ?? "", "retry");
      yield* settle;
      expect(list.list().find((item) => item.id === failed?.id)).toMatchObject({
        status: "done",
        filename: "same.txt",
      });
    }),
  );
  expect((await readdir(destination)).toSorted()).toEqual(["run.command", "same.txt"]);
  expect(await readFile(path.join(destination, "run.command"), "utf8")).toBe("sh");
});
it("startup removes previous-run roots while preserving live roots and unrelated files", async () => {
  const dead = path.join(folder, "openmail-attachments-99999999-AbCdEf");
  const legacy = path.join(folder, "openmail-attachments-AbCdEf");
  const live = path.join(folder, `openmail-attachments-${process.pid}-AbCdEf`);
  const other = path.join(folder, "unrelated");
  for (const root of [dead, legacy, live, other]) {
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, "private.txt"), "keep", { mode: 0o600 });
  }
  await utimes(legacy, new Date(0), new Date(0));
  await cleanupAttachmentTemps(folder);
  await expect(stat(dead)).rejects.toThrow();
  await expect(stat(legacy)).rejects.toThrow();
  expect(await readFile(path.join(live, "private.txt"), "utf8")).toBe("keep");
  expect(await readFile(path.join(other, "private.txt"), "utf8")).toBe("keep");
});
it("startup removes print leftovers without following a symlinked print folder", async () => {
  const legacy = path.join(folder, "openmail-print");
  const job = path.join(folder, "openmail-print-AbCdEf");
  const outside = await mkdtemp(path.join(tmpdir(), "om-print-target-"));
  const link = path.join(folder, "openmail-print-LnKdEf");
  try {
    for (const root of [legacy, job]) {
      await mkdir(root, { mode: 0o700 });
      await writeFile(path.join(root, "message.html"), "private", { mode: 0o600 });
    }
    await writeFile(path.join(outside, "keep.html"), "keep");
    await symlink(outside, link);
    await cleanupPrintTemps(folder);
    await expect(stat(legacy)).rejects.toThrow();
    await expect(stat(job)).rejects.toThrow();
    expect(await readFile(path.join(outside, "keep.html"), "utf8")).toBe("keep");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it("one print leftover that cannot be removed does not stop the sweep", async () => {
  const stuck = path.join(folder, "openmail-print-StUcKk");
  const locked = path.join(stuck, "locked");
  const other = path.join(folder, "openmail-print-OtHeRr");
  await mkdir(locked, { recursive: true });
  await writeFile(path.join(locked, "message.html"), "private");
  await chmod(locked, 0o500);
  await mkdir(other);
  try {
    await cleanupPrintTemps(folder);
    await expect(stat(other)).rejects.toThrow();
  } finally {
    await chmod(locked, 0o700);
  }
});
it("releasing replaced batches reclaims the byte budget immediately", async () => {
  const store = new AttachmentTemp(folder);
  const data = new Uint8Array(17 * 1024 * 1024);
  try {
    for (let index = 0; index < 9; index++) {
      const batch = await store.writeBatch([{ filename: "large.txt", data }]);
      await store.remove(batch);
      await expect(stat(batch.folder)).rejects.toThrow();
    }
  } finally {
    await store.dispose();
  }
});
it("launchers cannot be shared, copied or prepared for drag; Save remains available", async () => {
  await withFiles(
    (m, id, parent) =>
      Effect.gen(function* () {
        for (const action of ["open", "openWith", "preview", "share", "copy"] as const)
          expect(
            (yield* attachmentAction(
              m,
              parent,
              { messageId: id, paths: [[2]], action },
              noDownloads,
            ).pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect(
          (yield* prepareAttachmentDrag(m, parent, { messageId: id, paths: [[2]] }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(native.share).not.toHaveBeenCalled();
        expect(native.copy).not.toHaveBeenCalled();
        expect(native.drag).not.toHaveBeenCalled();
      }),
    "launch.webloc",
  );
});

it("Open With lists registered apps, opens only a registered one, and blocks launchers before listing", async () => {
  if (process.platform !== "darwin") return;
  await withFiles((m, id, parent) =>
    Effect.gen(function* () {
      expect(yield* attachmentApps(m, { messageId: id, path: [0] })).toEqual([
        { application: "/Applications/First.app", label: "First" },
        { application: "/Applications/Second.app", label: "Second" },
      ]);
      const result = yield* attachmentAction(
        m,
        parent,
        {
          messageId: id,
          paths: [[0]],
          action: "openWith",
          application: "/Applications/Second.app",
        },
        noDownloads,
      );
      expect(result.count).toBe(1);
      expect(native.openWith.mock.calls[0]?.[0]).toBe("/Applications/Second.app");
      // The renderer names the app; one not registered for the file is refused.
      yield* Effect.flip(
        attachmentAction(
          m,
          parent,
          {
            messageId: id,
            paths: [[1]],
            action: "openWith",
            application: "/Applications/Evil.app",
          },
          noDownloads,
        ),
      );
      expect(native.openWith).toHaveBeenCalledTimes(1);
      const calls = native.apps.mock.calls.length;
      yield* Effect.flip(attachmentApps(m, { messageId: id, path: [2] }));
      yield* Effect.flip(
        attachmentAction(
          m,
          parent,
          {
            messageId: id,
            paths: [[2]],
            action: "openWith",
            application: "/Applications/First.app",
          },
          noDownloads,
        ),
      );
      expect(native.apps).toHaveBeenCalledTimes(calls);
    }),
  );
});

for (const failure of ["list", "launch"] as const)
  it(`Open With removes temporary batches when ${failure} fails`, async () => {
    if (process.platform !== "darwin") return;
    await withFiles((m, id, parent) =>
      Effect.gen(function* () {
        const error = new Error("fixture failure");
        const { DeviceError } = yield* Effect.promise(
          () => import("../../../../../packages/core/src/domain/errors.js"),
        );
        const fail = Effect.fail(new DeviceError({ message: error.message }));
        if (failure === "list") native.apps.mockReturnValue(fail);
        else native.openWith.mockReturnValue(fail);
        const warm = yield* Effect.promise(() => attachmentTemp(app).writeBatch([]));
        yield* Effect.promise(() => attachmentTemp(app).remove(warm));
        const before = yield* Effect.promise(() =>
          readdir(folder, { recursive: true }).then((entries) => entries.toSorted()),
        );
        {
          const result = yield* Effect.result(
            attachmentAction(
              m,
              parent,
              {
                messageId: id,
                paths: [[0]],
                action: "openWith",
                application: "/Applications/First.app",
              },
              noDownloads,
            ),
          );
          expect(result._tag).toBe("Failure");
        }
        const after = yield* Effect.promise(() =>
          readdir(folder, { recursive: true }).then((entries) => entries.toSorted()),
        );
        expect(after).toEqual(before);
      }),
    );
  });
