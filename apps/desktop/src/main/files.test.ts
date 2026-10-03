import { buildMime } from "../../../../packages/core/src/platform/node/compose.js";
import { ProviderError } from "../../../../packages/core/src/errors.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Mailbox } from "../../../../packages/core/src/mailbox.js";
import { fakeServer, TestMailbox } from "../../../../packages/core/src/platform/node/testing.js";
import type { IncomingMessage } from "../../../../packages/core/src/domain.js";

vi.mock("@openmail/core", () => import("../../../../packages/core/src/index.js"));
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp") },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  BrowserWindow: vi.fn(),
  session: {},
  shell: {},
}));

import { app, dialog } from "electron";
import { saveAttachment, saveMessage, saveAllAttachments } from "./files";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "openmail-eml-"));
  vi.mocked(dialog).showSaveDialog.mockReset();
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const first: IncomingMessage = {
  providerId: "one",
  threadId: "thread",
  subject: "First",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "",
  bodyText: "",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
};
const serverForTest = () =>
  fakeServer("me@gmail.com", [
    first,
    { ...first, providerId: "two", subject: "../../Second: message" },
  ]);

it("dot-only attachment filenames cannot change the legacy save dialog directory", async () => {
  const server = fakeServer("me@gmail.com", [
    { ...first, attachments: [{ filename: " .. ", mimeType: "text/plain", size: 1 }] },
  ]);
  vi.mocked(app).getPath.mockReturnValue(folder);
  vi.mocked(dialog).showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        expect(yield* saveAttachment(mailbox, null, `${account.id}/one`, 0)).toBe(false);
      }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
    );
    expect(vi.mocked(dialog).showSaveDialog.mock.calls[0]?.[0]).toMatchObject({
      defaultPath: path.join(folder, "attachment"),
    });
  } finally {
    vi.mocked(app).getPath.mockReturnValue("/tmp");
  }
});

it("dot-only attachment filenames use a file in the configured save folder", async () => {
  const part = { filename: " .. ", mimeType: "text/plain", content: "YQ==" };
  const server = fakeServer("me@gmail.com", [{ ...first, attachments: [{ ...part, size: 1 }] }]);
  server.raw.set(
    "one",
    await Effect.runPromise(
      buildMime(first.from, {
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        text: "",
        attachments: [part],
      }),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      yield* mailbox.setPrefs({ attachmentSaveFolder: { kind: "custom", path: folder } });
      expect(yield* saveAttachment(mailbox, null, `${account.id}/one`, 0)).toBe(true);
    }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
  );
  expect(await readdir(folder)).toEqual(["attachment"]);
  expect(await readFile(path.join(folder, "attachment"), "utf8")).toBe("a");
});

it("saves the chosen message byte-for-byte, including non-UTF8 MIME", async () => {
  const server = serverForTest();
  const raw = Buffer.concat([
    Buffer.from("Subject: Second\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\n"),
    Buffer.from([0xe9, 0xff]),
  ]);
  server.raw.set("one", Buffer.from("Subject: First\r\n\r\nfirst"));
  server.raw.set("two", raw);
  const file = path.join(folder, "chosen.eml");
  vi.mocked(dialog).showSaveDialog.mockResolvedValue({ canceled: false, filePath: file });
  const saved = await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      return yield* saveMessage(mailbox, null, `${account.id}/two`);
    }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
  );
  expect(saved).toBe(true);
  expect(await readFile(file)).toEqual(raw);
  expect(vi.mocked(dialog).showSaveDialog.mock.calls[0]?.[0]).toMatchObject({
    defaultPath: "/tmp/_.._Second_ message.eml",
    filters: [{ name: "Email", extensions: ["eml"] }],
  });
});

it("cancel and a missing destination leave files intact and never fetch MIME", async () => {
  const server = serverForTest();
  const file = path.join(folder, "existing.eml");
  await writeFile(file, "keep");
  vi.mocked(dialog)
    .showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: file })
    .mockResolvedValueOnce({ canceled: false, filePath: "" });
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const raw = vi.spyOn(mailbox, "rawMessageBytes");
      expect(yield* saveMessage(mailbox, null, `${account.id}/two`)).toBe(false);
      expect(yield* saveMessage(mailbox, null, `${account.id}/two`)).toBe(false);
      expect(raw).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
  );
  expect(await readFile(file, "utf8")).toBe("keep");
  expect(await readdir(folder)).toEqual(["existing.eml"]);
});

it("provider failure leaves the chosen file intact", async () => {
  const server = serverForTest();
  const file = path.join(folder, "existing.eml");
  await writeFile(file, "keep");
  vi.mocked(dialog).showSaveDialog.mockResolvedValue({ canceled: false, filePath: file });
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      server.messages.delete("two");
      expect(
        (yield* saveMessage(mailbox, null, `${account.id}/two`).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
  );
  expect(await readFile(file, "utf8")).toBe("keep");
});

it("EML subjects preserve slash-separated words, use a message fallback and fit the filesystem", async () => {
  vi.mocked(app).getPath.mockReturnValue(folder);
  vi.mocked(dialog).showSaveDialog.mockImplementation(async (options) => ({
    canceled: false,
    filePath: options.defaultPath ?? "",
  }));
  try {
    const cases: readonly [string, string][] = [
      ["Q3/Q4 plan: review", "Q3_Q4 plan_ review.eml"],
      ["...", "message.eml"],
      ["邮件😀".repeat(100), ""],
    ];
    for (const [subject, expected] of cases) {
      const server = fakeServer("me@gmail.com", [{ ...first, subject }]);
      const saved = await Effect.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          yield* mailbox.sync();
          return yield* saveMessage(mailbox, null, `${account.id}/one`);
        }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
      );
      expect(saved).toBe(true);
      const chosen = vi.mocked(dialog).showSaveDialog.mock.calls.at(-1)?.[0];
      expect(chosen).toHaveProperty("defaultPath");
      if (chosen && "defaultPath" in chosen) {
        const name = path.basename(chosen.defaultPath ?? "");
        if (expected) expect(name).toBe(expected);
        expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(204);
        expect(name).not.toContain("\uFFFD");
        expect(await readFile(path.join(folder, name), "utf8")).toContain("Subject:");
      }
    }
  } finally {
    vi.mocked(app).getPath.mockReturnValue("/tmp");
  }
});

it("legacy Save All continues after a provider failure and reports the failed filename", async () => {
  const files = [
    { filename: "missing.txt", mimeType: "text/plain", content: "bWlzc2luZw==" },
    { filename: "saved.txt", mimeType: "text/plain", content: "c2F2ZWQ=" },
  ];
  const server = fakeServer("me@gmail.com", [
    {
      ...first,
      attachments: files.map((file) => ({
        filename: file.filename,
        mimeType: file.mimeType,
        size: 7,
      })),
    },
  ]);
  server.raw.set(
    "one",
    await Effect.runPromise(
      buildMime(first.from, { to: [], cc: [], bcc: [], subject: "", text: "", attachments: files }),
    ),
  );
  vi.mocked(dialog).showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [folder] });
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      server.failNext = new ProviderError({ message: "Part unavailable" });
      const result = yield* saveAllAttachments(mailbox, null, `${account.id}/one`).pipe(
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("missing.txt");
    }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
  );
  expect(await readFile(path.join(folder, "saved.txt"), "utf8")).toBe("saved");
});

for (const kind of ["downloads", "custom"] as const) {
  it(`attachment ${kind} setting saves without a dialog and never overwrites an existing file`, async () => {
    const listed = { filename: "saved.txt", mimeType: "text/plain", size: 5 };
    const server = fakeServer("me@gmail.com", [{ ...first, attachments: [listed] }]);
    server.raw.set(
      "one",
      await Effect.runPromise(
        buildMime(first.from, {
          to: [],
          cc: [],
          bcc: [],
          subject: "",
          text: "",
          attachments: [{ ...listed, content: "c2F2ZWQ=" }],
        }),
      ),
    );
    vi.mocked(app).getPath.mockReturnValue(folder);
    await writeFile(path.join(folder, "saved.txt"), "keep");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          yield* mailbox.sync();
          yield* mailbox.setPrefs({
            attachmentSaveFolder: kind === "custom" ? { kind, path: folder } : { kind },
          });
          expect(yield* saveAttachment(mailbox, null, `${account.id}/one`, 0)).toBe(true);
        }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
      );
      expect(vi.mocked(dialog).showSaveDialog.mock.calls).toHaveLength(0);
      expect(await readFile(path.join(folder, "saved.txt"), "utf8")).toBe("keep");
      expect(await readFile(path.join(folder, "saved (2).txt"), "utf8")).toBe("saved");
    } finally {
      vi.mocked(app).getPath.mockReturnValue("/tmp");
    }
  });
}
