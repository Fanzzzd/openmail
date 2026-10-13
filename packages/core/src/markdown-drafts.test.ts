import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { simpleParser } from "mailparser";

import { buildMime } from "./platform/node/compose.js";
import type { Provider, OutgoingMessage } from "./domain/domain.js";
import { importedMessage, parseRawDraft } from "./platform/node/portable-helpers.js";
import { Mailbox } from "./mailbox/mailbox.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";
import { renderMarkdown } from "./markdown.js";
import { ProviderError } from "./domain/errors.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { MailboxLive } from "./mailbox/mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store.js";

const source =
  "**bold**\n\n_italic_ [details](https://example.com)\n\n- first\n- second\n\n```\n  aligned\n```\n\n";
const message: OutgoingMessage = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Markdown",
  text: source,
  markdown: true,
  attachments: [],
};

it.effect(
  "Graph metadata failure imports the actual body as rich without losing offline access",
  () => {
    const server = fakeServer("me@example.com", [
      {
        providerId: "remote",
        threadId: "remote",
        subject: "Markdown",
        from: { name: "", address: "me@example.com" },
        to: message.to,
        cc: [],
        date: 1,
        snippet: "",
        bodyText: "bold",
        bodyHtml: "<b>bold</b>",
        labels: ["DRAFT"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      },
    ]);
    const adapter = {
      ...makeFakeProvider(server),
      draftMarkdownSource: () =>
        Effect.fail(new ProviderError({ message: "Source metadata unavailable" })),
    };
    const layer = MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provide(
        Layer.merge(StoreLive, Layer.succeed(Providers, Providers.of({ get: () => adapter }))),
      ),
      Layer.provide(MemoryPlatform()),
    );
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "outlook" });
      yield* mailbox.sync();
      const opened = yield* mailbox.openDraft("outlook:me@example.com/remote");
      assert.strictEqual(opened.message.markdown, undefined);
      assert.strictEqual(opened.message.text, "bold");
      assert.include(opened.message.originalHtml ?? "", "<b>bold</b>");
      assert.deepStrictEqual(server.draftLog, []);
      assert.deepStrictEqual(
        (yield* mailbox.threads({ mailbox: "drafts" })).map((row) => row.id),
        ["outlook:me@example.com/remote"],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "Outlook offline imports use cached HTML and never look up source metadata after raw fetch fails",
  () => {
    const server = fakeServer("me@example.com", [
      {
        providerId: "remote",
        threadId: "remote",
        subject: "Offline",
        from: { name: "", address: "me@example.com" },
        to: message.to,
        cc: [],
        date: 1,
        snippet: "",
        bodyText: "cached",
        bodyHtml: "<b>cached</b>",
        labels: ["DRAFT"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      },
    ]);
    let calls = 0;
    const adapter = {
      ...makeFakeProvider(server),
      fetchRaw: () => Effect.fail(new ProviderError({ message: "offline" })),
      draftMarkdownSource: () => {
        calls++;
        return Effect.fail(new ProviderError({ message: "must not run" }));
      },
    };
    const layer = MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provide(
        Layer.merge(StoreLive, Layer.succeed(Providers, Providers.of({ get: () => adapter }))),
      ),
      Layer.provide(MemoryPlatform()),
    );
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "outlook" });
      yield* mailbox.sync();
      const opened = yield* mailbox.openDraft("outlook:me@example.com/remote");
      assert.strictEqual(opened.message.text, "cached");
      assert.strictEqual(opened.message.originalHtml, "<b>cached</b>");
      assert.strictEqual(calls, 0);
    }).pipe(Effect.provide(layer));
  },
);

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: freshly imported remote Markdown keeps its source after successive edits`,
    () => {
      const server = fakeServer("me@example.com");
      const connect = () =>
        Effect.gen(function* () {
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
          return mailbox;
        });
      const accountId = `${provider}:${server.email}`;
      return Effect.gen(function* () {
        const firstRemote = yield* Effect.gen(function* () {
          const mailbox = yield* connect();
          yield* mailbox.saveDraft({ id: "draft:markdown", accountId, message });
          const entry = [...server.drafts.values()][0];
          assert.ok(entry);
          const raw = yield* buildMime(
            { name: "", address: server.email },
            entry.push.message,
            {},
            { draft: true },
          );
          const parsed = yield* Effect.promise(() => simpleParser(raw));
          assert.strictEqual(parsed.headers.get("x-openmail-markdown"), "1");
          assert.include(parsed.html || "", "<strong>bold</strong>");
          return entry.messageId;
        }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
        const secondRemote = yield* Effect.gen(function* () {
          const mailbox = yield* connect();
          yield* mailbox.sync();
          const opened = yield* mailbox.openDraft(`${accountId}/${firstRemote}`);
          assert.strictEqual(opened.message.markdown, true);
          assert.strictEqual(opened.message.text, source);
          assert.strictEqual(opened.message.html, undefined);
          const updated = { ...opened.message, text: source.replace("bold", "edited") };
          yield* mailbox.saveDraft({ id: opened.id, accountId, message: updated });
          const entry = [...server.drafts.values()].at(-1);
          assert.ok(entry);
          return entry.messageId;
        }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
        yield* Effect.gen(function* () {
          const mailbox = yield* connect();
          yield* mailbox.sync();
          const opened = yield* mailbox.openDraft(`${accountId}/${secondRemote}`);
          assert.strictEqual(opened.message.markdown, true);
          assert.strictEqual(opened.message.text, source.replace("bold", "edited"));
          yield* mailbox.perform(
            { kind: "send", accountId, message: opened.message },
            { kind: "user", surface: "app" },
          );
          assert.include(server.sent.at(-1)?.message.html ?? "", "<strong>edited</strong>");
        }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
      });
    },
  );
}

it.effect("marker is explicit: HTML alternatives without it import as rich text", () =>
  Effect.gen(function* () {
    const raw = yield* buildMime(
      { name: "", address: "me@example.com" },
      { ...message, markdown: false, html: "<b>bold</b>" },
    );
    const parsed = yield* parseRawDraft(raw);
    assert.strictEqual(importedMessage(parsed, []).markdown, undefined);
    assert.strictEqual(parsed.text, "bold");
  }),
);

it.effect("a marked empty Markdown draft remains Markdown", () =>
  Effect.gen(function* () {
    const raw = yield* buildMime(
      { name: "", address: "me@example.com" },
      { ...message, text: "", html: renderMarkdown("") },
      {},
      { draft: true },
    );
    const parsed = yield* parseRawDraft(raw);
    assert.strictEqual(parsed.markdown, true);
    assert.strictEqual(parsed.text, "");
  }),
);
