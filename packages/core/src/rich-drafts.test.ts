import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";

import { buildMime } from "./compose.js";
import { richComposeBody, preservedComposeHtml, remoteComposeBody } from "./compose-body.js";
import { databaseLayer } from "./db.js";
import type { Actor, IncomingMessage, Provider } from "./domain.js";
import { ProviderError } from "./errors.js";
import { makeFakeProvider } from "./fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform-memory.js";
import { NodeSystem } from "./platform-node.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store.js";
import { fakeServer, TestMailbox } from "./testing.js";

const user: Actor = { kind: "user", surface: "app" };
const html =
  '<p style="color:red"><b>你好</b> <i>italic</i> <u>underline</u><br><a href="https://example.com/?a=1&amp;b=2" onclick="bad()">link</a><script>bad()</script><img src="https://tracker.test" onerror="bad()"><a href="jav&#x61;script:bad()">label</a></p><table><tr><td>Cell</td></tr></table><ul><li>Item</li></ul>';
const expected = richComposeBody(html);
const remote: IncomingMessage = {
  providerId: "remote",
  threadId: "remote",
  subject: "Rich draft",
  from: { name: "", address: "me@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [],
  date: 1,
  snippet: "",
  bodyText: "stale alternative",
  bodyHtml: html,
  labels: ["DRAFT"],
  attachments: [],
  isUnread: false,
  isStarred: false,
};
// Raw provider bytes bypass our outgoing sanitizer, as drafts from other clients do.
const raw = Buffer.from(
  [
    "From: me@example.com",
    "To: Bob <bob@example.com>",
    "Subject: Rich draft",
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=rich",
    "",
    "--rich",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "stale alternative",
    "--rich",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "--rich--",
    "",
  ].join("\r\n"),
);

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: remote HTML survives save, database reopen, provider push and MIME send`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-rich-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer("me@example.com", [remote]);
        server.raw.set("remote", raw);
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
        const id = yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    password: "fake",
                    imapHost: "imap.example.com",
                    imapPort: 993,
                    smtpHost: "smtp.example.com",
                    smtpPort: 465,
                    smtpSecure: true,
                  },
                }
              : { provider },
          );
          yield* mailbox.sync();
          const opened = yield* mailbox.openDraft(`${provider}:${server.email}/remote`);
          assert.strictEqual(opened.message.html, expected.html);
          assert.strictEqual(opened.message.text, expected.text);
          const saved = yield* mailbox.saveDraft({
            id: opened.id,
            accountId: opened.accountId,
            message: { ...opened.message, subject: "Changed subject only", text: "stale again" },
          });
          assert.strictEqual(saved.message.text, expected.text);
          const push = server.draftLog.at(-1);
          assert.ok(push?.kind === "save");
          assert.strictEqual(push.push.message.html, preservedComposeHtml(html));
          assert.strictEqual(saved.message.originalHtml, html);
          assert.include(push.push.message.html ?? "", 'style="color:red"');
          assert.include(push.push.message.html ?? "", "<table><tr><td>Cell</td></tr></table>");
          assert.include(push.push.message.html ?? "", '<img src="https://tracker.test">');
          assert.notMatch(push.push.message.html ?? "", /<script|onclick=|onerror=|javascript:/i);
          assert.strictEqual(push.push.message.text, expected.text);
          return opened.id;
        }).pipe(Effect.provide(layer()));

        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const reopened = yield* mailbox.openDraft(id);
          assert.strictEqual(reopened.message.html, expected.html);
          assert.strictEqual(reopened.message.text, expected.text);
          assert.strictEqual(reopened.message.originalHtml, html);
          // Editing one marked span keeps all other formatting.
          const editedHtml = expected.html.replace("你好", "改过");
          const edited = { ...reopened.message, html: editedHtml, text: "stale after editing" };
          const saved = yield* mailbox.saveDraft({
            id,
            accountId: reopened.accountId,
            message: edited,
          });
          yield* mailbox.perform(
            { kind: "send", accountId: reopened.accountId, draftId: id, message: saved.message },
            user,
          );
          const sent = server.sent.at(-1);
          assert.ok(sent);
          assert.strictEqual(sent.message.html, editedHtml);
          assert.strictEqual(saved.message.originalHtml, undefined);
          assert.strictEqual(sent.message.text, expected.text.replace("你好", "改过"));
          const mime = yield* buildMime({ name: "", address: server.email }, sent.message);
          const parsed = yield* Effect.promise(() => simpleParser(mime));
          assert.strictEqual(parsed.text?.trim(), sent.message.text);
          assert.include(
            parsed.html || "",
            "<strong>改过</strong><em> italic</em><u> underline</u>",
          );
          assert.include(parsed.html || "", '<a href="https://example.com/?a=1&amp;b=2">link</a>');
          assert.notMatch(parsed.html || "", /<script|<img|onclick=|javascript:/i);
        }).pipe(Effect.provide(layer()));
      }),
  );
}

it.effect("offline remote draft import preserves and sanitizes cached HTML", () => {
  const server = fakeServer("me@gmail.com", [remote]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    server.failNext = new ProviderError({ message: "offline" });
    const draft = yield* mailbox.openDraft("gmail:me@gmail.com/remote");
    assert.strictEqual(draft.message.html, expected.html);
    assert.strictEqual(draft.message.text, expected.text);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("sending HTML directly also sanitizes and derives the text alternative", () => {
  const server = fakeServer("me@gmail.com");
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.perform(
      {
        kind: "send",
        accountId: "gmail:me@gmail.com",
        message: {
          to: remote.to,
          cc: [],
          bcc: [],
          subject: "Direct",
          text: "stale",
          html,
          attachments: [],
        },
      },
      user,
    );
    assert.strictEqual(server.sent[0]?.message.html, expected.html);
    assert.strictEqual(server.sent[0]?.message.text, expected.text);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: editing a remote body removes inline image MIME parts before save and send`,
    () => {
      const server = fakeServer("me@example.com");
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        yield* mailbox.connect(
          provider === "imap"
            ? {
                provider,
                input: {
                  preset: "custom",
                  email: server.email,
                  password: "fake",
                  imapHost: "imap.example.com",
                  imapPort: 993,
                  smtpHost: "smtp.example.com",
                  smtpPort: 465,
                  smtpSecure: true,
                },
              }
            : { provider },
        );
        const body = remoteComposeBody('<p>before<img src="cid:logo@example.com"></p>');
        const normal = { filename: "ordinary.png", mimeType: "image/png", content: "aGk=" };
        const inline = { ...normal, filename: "inline.png", contentId: "logo@example.com" };
        const accountId = `${provider}:${server.email}`;
        const saved = yield* mailbox.saveDraft({
          id: "draft:images",
          accountId,
          message: {
            to: remote.to,
            cc: [],
            bcc: [],
            subject: "Images",
            text: body.text,
            html: body.html,
            originalHtml: body.originalHtml,
            attachments: [normal, inline],
          },
        });
        assert.deepStrictEqual(saved.message.attachments, [normal, inline]);
        const edited = yield* mailbox.saveDraft({
          id: saved.id,
          accountId,
          message: { ...saved.message, html: "<strong>after</strong>" },
        });
        assert.deepStrictEqual(edited.message.attachments, [normal]);
        const push = server.draftLog.at(-1);
        assert.ok(push?.kind === "save");
        assert.deepStrictEqual(push.push.message.attachments, [normal]);
        yield* mailbox.perform({ kind: "send", accountId, message: edited.message }, user);
        const sent = server.sent.at(-1);
        assert.ok(sent);
        const mime = yield* buildMime({ name: "", address: server.email }, sent.message);
        const parsed = yield* Effect.promise(() => simpleParser(mime, { skipImageLinks: true }));
        assert.deepStrictEqual(
          parsed.attachments.map((part) => part.filename),
          ["ordinary.png"],
        );
        assert.ok(parsed.attachments.every((part) => !part.contentId));
      }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
    },
  );
}
