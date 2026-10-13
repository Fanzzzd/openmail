import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import {
  attachmentBytes,
  attachmentProblem,
  reorderAttachments,
} from "../mime/attachment-policy.js";
import { composeMatches } from "./compose-find.js";
import { buildMime } from "../platform/node/compose.js";
import { richComposeBody, remoteComposeBody, normalizeComposeMessage } from "./compose-body.js";
import { databaseLayer } from "../platform/node/db.js";
import type { IncomingMessage, OutgoingAttachment, OutgoingMessage } from "../domain/domain.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { Providers } from "../services.js";
import { StoreLive } from "../store/store.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";
import { ProviderError } from "../domain/errors.js";

const file = { filename: "same.txt", mimeType: "text/plain", content: "aGk=" };
const outgoing: OutgoingMessage = {
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Files",
  text: "Body",
  attachments: [file, { ...file, content: "Ynll" }],
};
const original: IncomingMessage = {
  providerId: "original",
  threadId: "thread",
  subject: "Files",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "Body",
  bodyText: "Body",
  bodyHtml: "<b>Body</b>",
  labels: ["INBOX"],
  attachments: [
    { filename: file.filename, mimeType: file.mimeType, size: 2 },
    { filename: file.filename, mimeType: file.mimeType, size: 3 },
  ],
  isUnread: false,
  isStarred: false,
};

for (const provider of ["gmail", "imap", "outlook"] as const) {
  it.effect(
    `${provider}: original parts survive reordering, draft reopening and reply/forward sends`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-attachments-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const server = fakeServer("me@example.com", [original]);
        server.raw.set("original", yield* buildMime(original.from, outgoing));
        const adapter = makeFakeProvider(server);
        const layer = () =>
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provide(
              Layer.merge(
                StoreLive.pipe(
                  Layer.provide(
                    databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
                  ),
                ),
                Layer.succeed(Providers, Providers.of({ get: () => adapter })),
              ),
            ),
            Layer.provide(MemoryPlatform()),
          );
        const saved = yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    password: "pw",
                    imapHost: "imap.example.com",
                    smtpHost: "smtp.example.com",
                  },
                }
              : { provider },
          );
          yield* mailbox.sync();
          const id = `${account.id}/original`;
          const parts = yield* mailbox.composeAttachments(id);
          assert.deepStrictEqual(
            parts.map((part) => part.content),
            ["aGk=", "Ynll"],
          );
          assert.ok(parts.every((part) => part.sourceMessageId === id));
          const body = remoteComposeBody(
            '<table><tr><td style="color:red">Body</td></tr></table><script>unsafe()</script>',
          );
          const saved = yield* mailbox.saveDraft({
            id: "draft:parts",
            accountId: account.id,
            message: {
              ...outgoing,
              text: body.text,
              html: body.html,
              originalHtml: body.originalHtml,
              attachments: reorderAttachments(parts, 0, 1),
              mode: "forward",
              inReplyTo: id,
              includeOriginalAttachments: true,
            },
          });
          yield* mailbox.setPrefs({ quoteSelection: "always" });
          return saved;
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const reopened = yield* mailbox.openDraft(saved.id);
          assert.deepStrictEqual(reopened.message, saved.message);
          assert.strictEqual((yield* mailbox.prefs).quoteSelection, "always");
          yield* mailbox.perform(
            { kind: "send", accountId: saved.accountId, message: reopened.message },
            { kind: "user", surface: "app" },
          );
          assert.deepStrictEqual(
            server.sent[0]?.message.attachments.map((part) => part.content),
            ["Ynll", "aGk="],
          );
          assert.include(server.sent[0]?.message.html ?? "", "<table>");
          assert.notInclude(server.sent[0]?.message.html ?? "", "script");
          yield* mailbox.perform(
            {
              kind: "send",
              accountId: saved.accountId,
              message: { ...reopened.message, mode: "reply", includeOriginalAttachments: true },
            },
            { kind: "user", surface: "app" },
          );
          assert.strictEqual(server.sent[1]?.message.attachments.length, 2);
          yield* mailbox.perform(
            {
              kind: "send",
              accountId: saved.accountId,
              message: { ...reopened.message, attachments: [], includeOriginalAttachments: false },
            },
            { kind: "user", surface: "app" },
          );
          assert.strictEqual(server.sent[2]?.message.attachments.length, 0);
        }).pipe(Effect.provide(layer()));
      }),
  );
}

it.effect(
  "core rejects blocked Gmail files before the provider or send queue and reports original attachment fetch failures",
  () => {
    const server = fakeServer("me@example.com", [original]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const error = yield* Effect.flip(
        mailbox.perform(
          {
            kind: "send",
            accountId: account.id,
            message: { ...outgoing, attachments: [{ ...file, filename: "SETUP.EXE" }] },
          },
          { kind: "user", surface: "app" },
        ),
      );
      assert.strictEqual(error._tag, "InvalidInput");
      assert.include(error.message, "SETUP.EXE");
      assert.strictEqual(server.sent.length, 0);
      assert.strictEqual(yield* mailbox.pendingSendCount, 0);
      server.failNext = new ProviderError({ message: "Original MIME unavailable" });
      const fetchError = yield* Effect.flip(mailbox.composeAttachments(`${account.id}/original`));
      assert.strictEqual(fetchError._tag, "ProviderError");
      assert.include(fetchError.message, "Original MIME unavailable");
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it("attachment preflight accounts for padding, aggregate size, forbidden types and compressed suffixes", () => {
  assert.strictEqual(attachmentBytes("YQ=="), 1);
  assert.strictEqual(attachmentBytes("aGk=\n"), 2);
  assert.strictEqual(attachmentBytes("Ynll"), 3);
  assert.strictEqual(attachmentProblem("gmail", [file]), undefined);
  for (const filename of ["a.EXE", "a.mjs", "a.exe.gz", "a.exe.gz.bz2", "a.iso", "a.bat "])
    assert.deepStrictEqual(attachmentProblem("gmail", [{ ...file, filename }]), {
      kind: "gmailBlocked",
      filename,
    });
  assert.strictEqual(
    attachmentProblem("gmail", [{ ...file, mimeType: "application/x-executable" }])?.kind,
    "gmailBlocked",
  );
  const mb = { ...file, content: "A".repeat(4 * 1024 * 1024) };
  assert.strictEqual(attachmentProblem("outlook", [mb]), undefined);
  assert.strictEqual(
    attachmentProblem(
      "outlook",
      Array.from({ length: 9 }, () => mb),
    )?.kind,
    "outlookSize",
  );
  assert.strictEqual(
    attachmentProblem(
      "gmail",
      Array.from({ length: 9 }, () => mb),
    )?.kind,
    "gmailSize",
  );
  assert.strictEqual(attachmentProblem("imap", [mb, mb]), undefined);
});

it("Gmail rejects 19 MiB decoded attachments because their encoded MIME exceeds 25 MiB", () => {
  const content = Buffer.alloc(19 * 1024 * 1024).toString("base64");
  assert.strictEqual(attachmentProblem("gmail", [{ ...file, content }])?.kind, "gmailSize");
});

it.effect(
  "a forwarded CID chip remains an attachment after converting or editing away its image",
  () =>
    Effect.gen(function* () {
      const message = normalizeComposeMessage({
        ...outgoing,
        text: "Selected text",
        attachments: [{ ...file, sourceMessageId: "original", contentId: "unreferenced@openmail" }],
      });
      assert.strictEqual(message.attachments.length, 1);
      assert.strictEqual(message.attachments[0]?.contentId, undefined);
      const raw = yield* buildMime(original.from, message);
      const parsed = yield* Effect.promise(() => simpleParser(raw));
      assert.strictEqual(parsed.attachments[0]?.content.toString(), "hi");
    }),
);

it.effect(
  "original attachment size metadata rejects a large fetch before the provider is called",
  () => {
    const server = fakeServer("me@example.com", [
      {
        ...original,
        attachments: [
          { filename: "large.pdf", mimeType: "application/pdf", size: 30 * 1024 * 1024 },
        ],
      },
    ]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      server.failNext = new ProviderError({ message: "Must not fetch raw MIME" });
      const error = yield* Effect.flip(mailbox.composeAttachments(`${account.id}/original`));
      assert.strictEqual(error._tag, "InvalidInput");
      assert.strictEqual(server.failNext.message, "Must not fetch raw MIME");
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it("reordering keeps same-name files and inline CID identity distinct, with stable boundary moves", () => {
  const parts: readonly OutgoingAttachment[] = [
    file,
    { ...file, contentId: "part@openmail", content: "Ynll" },
    { ...file, content: "eA==" },
  ];
  const moved = reorderAttachments(parts, 0, 2);
  assert.deepStrictEqual(
    moved.map((part) => part.content),
    ["Ynll", "eA==", "aGk="],
  );
  assert.strictEqual(moved[0]?.contentId, "part@openmail");
  assert.deepStrictEqual(reorderAttachments(moved, 2, 0), parts);
  assert.strictEqual(reorderAttachments(parts, 0, 0), parts);
  assert.strictEqual(reorderAttachments(parts, -1, 1), parts);
  assert.strictEqual(reorderAttachments(parts, 0, parts.length), parts);
  assert.deepStrictEqual(reorderAttachments([], 0, 1), []);
});

it.effect(
  "CID image editing and MIME round-trip keep local parts and remove remote image sources",
  () =>
    Effect.gen(function* () {
      const body = richComposeBody(
        '<b>Before</b><img src="cid:image@openmail" onerror="unsafe()"><img src="https://attacker.test/tracker"><img src="data:image/svg+xml,bad"><script>bad()</script>',
      );
      assert.include(body.html, 'src="cid:image@openmail"');
      assert.notMatch(body.html, /https:|data:|onerror|script/);
      const message = normalizeComposeMessage({
        ...outgoing,
        text: body.text,
        html: body.html,
        attachments: [
          {
            filename: "image.png",
            mimeType: "image/png",
            content: "aGk=",
            contentId: "image@openmail",
          },
        ],
      });
      const raw = yield* buildMime(original.from, message);
      const parsed = yield* Effect.promise(() => simpleParser(raw, { skipImageLinks: true }));
      assert.strictEqual(parsed.attachments[0]?.contentId, "<image@openmail>");
      assert.include(parsed.html || "", 'src="cid:image@openmail"');
      assert.strictEqual(parsed.attachments[0]?.content.toString(), "hi");
    }),
);

it("find treats metacharacters literally and preserves original Unicode offsets", () => {
  assert.deepStrictEqual(composeMatches("a+b A+B", "a+b"), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
  ]);
  assert.deepStrictEqual(composeMatches("😀中文 中文", "中文"), [
    { start: 2, end: 4 },
    { start: 5, end: 7 },
  ]);
  assert.deepStrictEqual(composeMatches("body", ""), []);
  assert.deepStrictEqual(composeMatches("body", "absent"), []);
});
