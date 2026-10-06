import { applyNativeMigration } from "./platform/node/migrations.js";
import {
  incoming as buildIncoming,
  outgoing,
  type FakeServer,
  fakeServer,
  TestMailbox,
} from "./platform/node/testing.js";
import { draftCreation } from "./platform/node/draft-create-fixture.js";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Deferred, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { simpleParser } from "mailparser";
import { buildMime } from "./platform/node/compose.js";
import { type Actor, DEFAULT_PREFS, type IncomingMessage, type OutgoingMessage } from "./domain.js";
import { ProviderError } from "./errors.js";
import { Mailbox } from "./mailbox.js";
import { richComposeBody } from "./compose-body.js";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "./platform/node/db.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { Store, type ProviderAdapter } from "./services.js";
import { applyComposeSignature, replyFromAddress } from "./signatures.js";
{
  const GMAIL = "gmail:me@gmail.com";

  const OUTLOOK = "outlook:me@outlook.com";

  const user: Actor = { kind: "user", surface: "app" };

  const agent: Actor = { kind: "agent", surface: "mcp", name: "claude", rationale: "asked" };

  function incoming(providerId: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return buildIncoming(providerId, { labels: ["INBOX"], isUnread: false, ...overrides });
  }

  const bob = { name: "Bob", address: "bob@example.com" };

  const draftMessage = outgoing;

  function withMail<A, E>(
    body: (m: Mailbox["Service"], gmail: FakeServer, outlook: FakeServer) => Effect.Effect<A, E>,
    messages: IncomingMessage[] = [],
  ) {
    const gmail = fakeServer("me@gmail.com", messages);
    const outlook = fakeServer("me@outlook.com");
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      return yield* body(m, gmail, outlook);
    }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
  }

  const draftIds = (m: Mailbox["Service"]) =>
    Effect.map(m.threads({ mailbox: "drafts" }), (list) => list.map((t) => t.id));

  it.effect("a draft saves locally, syncs to the provider and stays one entry in Drafts", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        const saved = yield* m.saveDraft({
          id: "draft:1",
          accountId: GMAIL,
          message: draftMessage(),
        });
        assert.strictEqual(saved.synced, true);
        assert.strictEqual(server.drafts.size, 1);
        assert.deepStrictEqual(yield* draftIds(m), ["draft:1"]);

        // After a pull the list shows the provider's copy, which opens the same draft.
        yield* m.sync();
        const [row] = yield* draftIds(m);
        assert.ok(row?.startsWith(`${GMAIL}/`));
        assert.strictEqual((yield* m.openDraft(row!)).id, "draft:1");

        // A second save updates the same provider draft; the old copy leaves the list.
        yield* m.saveDraft({
          id: "draft:1",
          accountId: GMAIL,
          message: draftMessage({ text: "v2" }),
        });
        assert.strictEqual(server.drafts.size, 1);
        const second = server.draftLog[1];
        assert.ok(second?.kind === "save");
        assert.strictEqual(second.push.remote?.draftId, [...server.drafts.keys()][0]);
        assert.deepStrictEqual(yield* draftIds(m), ["draft:1"]);
        yield* m.sync();
        assert.strictEqual((yield* draftIds(m)).length, 1);
        assert.strictEqual((yield* m.openDraft("draft:1")).message.text, "v2");
      }),
    ),
  );

  it.effect("a thread read before the draft was saved again still opens the draft", () =>
    withMail(
      (m) =>
        Effect.gen(function* () {
          yield* m.saveDraft({ id: "draft:1", accountId: GMAIL, message: draftMessage() });
          yield* m.sync();
          const [row] = yield* draftIds(m);
          const [copy] = yield* m.thread(row!);
          assert.strictEqual(copy?.draftId, "draft:1");

          // Gmail replaces the message on update: the reader's copy is gone.
          yield* m.saveDraft({
            id: "draft:1",
            accountId: GMAIL,
            message: draftMessage({ text: "v2" }),
          });
          assert.strictEqual((yield* Effect.flip(m.openDraft(copy!.id)))._tag, "NotFound");
          // The local draft id it carries still works.
          assert.strictEqual((yield* m.openDraft(copy!.draftId!)).message.text, "v2");

          // A message that is not a copy of a local draft has none.
          yield* m.sync();
          const [inbox] = yield* m.threads({ mailbox: "inbox" });
          assert.strictEqual((yield* m.thread(inbox!.id))[0]?.draftId, undefined);
        }),
      [incoming("i1")],
    ),
  );

  it.effect("a draft saved offline stays local and goes out after backoff", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        server.failNext = new ProviderError({ message: "offline" });
        const saved = yield* m.saveDraft({
          id: "draft:1",
          accountId: GMAIL,
          message: draftMessage(),
        });
        assert.strictEqual(saved.synced, false);
        assert.strictEqual(server.drafts.size, 0);
        assert.deepStrictEqual(yield* draftIds(m), ["draft:1"]);

        yield* TestClock.adjust("5 seconds");
        yield* m.sync();
        assert.strictEqual(server.drafts.size, 1);
        assert.strictEqual((yield* m.openDraft("draft:1")).synced, true);
      }),
    ),
  );

  it.effect("sending a saved draft sends it and removes it here and on the provider", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        yield* m.saveDraft({ id: "draft:1", accountId: GMAIL, message: draftMessage() });
        yield* m.sync();
        const outcome = yield* m.perform(
          { kind: "send", accountId: GMAIL, message: draftMessage(), draftId: "draft:1" },
          user,
        );
        assert.strictEqual(outcome.status, "applied");
        assert.strictEqual(server.sent.length, 1);
        assert.strictEqual(server.drafts.size, 0);
        assert.deepStrictEqual(yield* draftIds(m), []);
        const missing = yield* Effect.flip(m.openDraft("draft:1"));
        assert.strictEqual(missing._tag, "NotFound");
      }),
    ),
  );

  it.effect("send and archive sends the reply, then archives the thread", () =>
    withMail(
      (m, server) =>
        Effect.gen(function* () {
          const [thread] = yield* m.threads({ mailbox: "inbox" });
          const reply = draftMessage({
            mode: "reply",
            inReplyTo: thread!.id,
            subject: "Re: 主题 m1",
          });
          yield* m.saveDraft({ id: "draft:r", accountId: GMAIL, message: reply });
          const outcome = yield* m.perform(
            { kind: "send", accountId: GMAIL, message: reply, draftId: "draft:r", archive: true },
            user,
          );
          assert.strictEqual(outcome.status === "applied" && outcome.flush?.done, 2);
          assert.strictEqual(server.sent.length, 1);
          assert.deepStrictEqual(yield* m.threads({ mailbox: "inbox" }), []);
          assert.deepStrictEqual(
            server.pushed.map((p) => p.op),
            [{ kind: "archive" }],
          );
        }),
      [incoming("m1")],
    ),
  );

  it.effect("discarding deletes the draft on the provider and is audited", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        yield* m.saveDraft({ id: "draft:1", accountId: GMAIL, message: draftMessage() });
        yield* m.discardDraft("draft:1");
        assert.strictEqual(server.drafts.size, 0);
        assert.deepStrictEqual(yield* draftIds(m), []);
        assert.strictEqual((yield* m.audit(1))[0]?.action, "discard_draft");
      }),
    ),
  );

  it.effect("a draft deleted in another client disappears after the next sync", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        yield* m.saveDraft({ id: "draft:1", accountId: GMAIL, message: draftMessage() });
        yield* m.sync();
        for (const [id, d] of server.drafts) {
          server.drafts.delete(id);
          server.messages.delete(d.messageId);
        }
        yield* m.sync();
        assert.deepStrictEqual(yield* draftIds(m), []);
        assert.strictEqual((yield* Effect.flip(m.openDraft("draft:1")))._tag, "NotFound");
      }),
    ),
  );

  it.effect("a draft sent from another client (same id, no DRAFT label) leaves Drafts", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        yield* m.saveDraft({ id: "draft:1", accountId: GMAIL, message: draftMessage() });
        const [draft] = [...server.drafts.values()];
        const copy = server.messages.get(draft!.messageId)!;
        server.messages.set(copy.providerId, { ...copy, labels: ["SENT"] });
        yield* m.sync();
        assert.deepStrictEqual(yield* draftIds(m), []);
        assert.strictEqual((yield* Effect.flip(m.openDraft("draft:1")))._tag, "NotFound");
      }),
    ),
  );

  it.effect(
    "a draft written in another client opens with Bcc and attachments, and saves in place",
    () =>
      Effect.gen(function* () {
        const reply: OutgoingMessage = {
          to: [{ name: "Alice", address: "alice@example.com" }],
          cc: [],
          bcc: [{ name: "", address: "boss@example.com" }],
          subject: "Re: 主题 m1",
          text: "草稿正文",
          attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" }],
          mode: "reply",
        };
        const raw = yield* buildMime({ name: "", address: "me@gmail.com" }, reply, {
          messageId: "<m1@example.com>",
        });
        const elsewhere = incoming("x1", {
          threadId: "t-m1",
          date: 2_000,
          labels: ["DRAFT"],
          subject: reply.subject,
          attachments: [{ filename: "a.txt", mimeType: "text/plain", size: 2 }],
        });
        yield* withMail(
          (m, server) =>
            Effect.gen(function* () {
              server.raw.set("x1", new Uint8Array(raw));
              server.drafts.set("web", {
                messageId: "x1",
                push: {
                  creation: draftCreation(),
                  remote: null,
                  message: reply,
                  original: Option.none(),
                  replaceAttachments: true,
                },
              });
              const opened = yield* m.openDraft(`${GMAIL}/x1`);
              assert.deepStrictEqual(opened.message.bcc, reply.bcc);
              assert.deepStrictEqual(opened.message.attachments, reply.attachments);
              assert.strictEqual(opened.message.mode, "reply");
              assert.strictEqual(opened.message.inReplyTo, `${GMAIL}/m1`);
              assert.strictEqual(opened.synced, true);
              // Opening it again finds the same local draft.
              assert.strictEqual((yield* m.openDraft(`${GMAIL}/x1`)).id, opened.id);

              yield* m.saveDraft({
                id: opened.id,
                accountId: GMAIL,
                message: { ...opened.message, text: "改过" },
              });
              const last = server.draftLog.at(-1);
              assert.ok(last?.kind === "save");
              assert.deepStrictEqual(last.push.remote, { draftId: null, messageId: "x1" });
              assert.deepStrictEqual([...server.drafts.keys()], ["web"]);
            }),
          [incoming("m1"), elsewhere],
        );
      }),
  );

  it.effect("a read-only MCP agent cannot create a draft", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        const outcome = yield* m.perform(
          { kind: "draft", accountId: GMAIL, message: draftMessage() },
          agent,
        );
        assert.strictEqual(outcome.status, "denied");
        assert.strictEqual((yield* draftIds(m)).length, 0);
        yield* m.sync();
        assert.strictEqual(server.drafts.size, 0);
      }),
    ),
  );

  it.effect("an MCP draft stays local until a person saves or sends it", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        yield* m.setAgentWriteMode("propose");
        const outcome = yield* m.perform(
          { kind: "draft", accountId: GMAIL, message: draftMessage() },
          agent,
        );
        assert.strictEqual(outcome.status, "proposed");
        const proposalId = outcome.status === "proposed" ? outcome.proposalId : -1;
        assert.strictEqual((yield* draftIds(m)).length, 1);
        // MCP does not queue a provider save, including at the next app sync.
        assert.strictEqual(server.drafts.size, 0);
        yield* m.sync();
        assert.strictEqual(server.drafts.size, 0);
        assert.strictEqual(server.sent.length, 0);

        const draft = yield* m.openDraft(`proposal:${proposalId}`);
        assert.strictEqual(draft.proposalId, proposalId);
        yield* m.perform(
          { kind: "send", accountId: GMAIL, message: draft.message, draftId: draft.id },
          user,
        );
        assert.strictEqual(server.sent.length, 1);
        assert.strictEqual(server.drafts.size, 0);
        assert.deepStrictEqual(yield* m.proposals, []);
        assert.ok((yield* m.audit(10)).some((e) => e.action === "approve"));

        // Rejecting a message proposal discards its draft.
        const second = yield* m.perform(
          { kind: "draft", accountId: GMAIL, message: draftMessage({ subject: "二" }) },
          agent,
        );
        yield* m.sync();
        assert.strictEqual(server.drafts.size, 0);
        yield* m.decideProposal(
          second.status === "proposed" ? second.proposalId : -1,
          false,
          "app",
        );
        assert.strictEqual(server.drafts.size, 0);
        assert.deepStrictEqual(yield* draftIds(m), []);
      }),
    ),
  );

  it.effect("an agent cannot draft from an account that does not exist", () =>
    withMail((m) =>
      Effect.gen(function* () {
        yield* m.setAgentWriteMode("propose");
        const error = yield* Effect.flip(
          m.perform(
            { kind: "draft", accountId: "gmail:nobody@x.com", message: draftMessage() },
            agent,
          ),
        );
        assert.strictEqual(error._tag, "NotFound");
        assert.deepStrictEqual(yield* m.proposals, []);
      }),
    ),
  );

  it.effect("forward as attachment sends the original as an .eml on a new message", () =>
    withMail(
      (m, server) =>
        Effect.gen(function* () {
          yield* m.perform(
            {
              kind: "send",
              accountId: GMAIL,
              message: draftMessage({
                subject: "Fwd: 主题 m1",
                text: "见附件",
                mode: "forward",
                inReplyTo: `${GMAIL}/m1`,
                forwardAsAttachment: true,
              }),
            },
            user,
          );
          const [sent] = server.sent;
          assert.ok(sent);
          assert.strictEqual(sent.message.mode, "new");
          assert.strictEqual(sent.message.inReplyTo, undefined);
          assert.ok(Option.isNone(sent.original));
          const [eml] = sent.message.attachments;
          assert.strictEqual(eml?.mimeType, "message/rfc822");
          assert.strictEqual(eml?.filename, "主题 m1.eml");
          assert.match(Buffer.from(eml!.content, "base64").toString(), /^Subject: /m);
        }),
      [incoming("m1")],
    ),
  );

  it.effect("Markdown bodies go out with a rendered HTML part", () =>
    withMail((m, server) =>
      Effect.gen(function* () {
        yield* m.perform(
          {
            kind: "send",
            accountId: GMAIL,
            message: draftMessage({ text: "**粗体**\n\n```\ncode\n```", markdown: true }),
          },
          user,
        );
        const html = server.sent[0]?.message.html ?? "";
        assert.match(html, /<strong>粗体<\/strong>/);
        assert.match(html, /<pre style=/);
        assert.strictEqual(server.sent[0]?.message.text, "**粗体**\n\n```\ncode\n```");
      }),
    ),
  );

  it.effect("Markdown forwards as attachments keep generated lists and code through MIME", () =>
    withMail(
      (m, server) =>
        Effect.gen(function* () {
          const source = "**bold**\n\n- list\n\n```\ncode\n```";
          yield* m.perform(
            {
              kind: "send",
              accountId: GMAIL,
              message: draftMessage({
                text: source,
                markdown: true,
                mode: "forward",
                inReplyTo: `${GMAIL}/m1`,
                forwardAsAttachment: true,
              }),
            },
            user,
          );
          const sent = server.sent[0];
          assert.ok(sent);
          assert.strictEqual(sent.message.text, source);
          const raw = yield* buildMime({ name: "", address: "me@gmail.com" }, sent.message);
          const parsed = yield* Effect.promise(() => simpleParser(raw));
          assert.include(parsed.html || "", "<strong>bold</strong>");
          assert.include(parsed.html || "", "<li>list</li>");
          assert.include(parsed.html || "", "<pre style=");
          assert.strictEqual(parsed.attachments[0]?.contentType, "message/rfc822");
        }),
      [incoming("m1")],
    ),
  );

  it.effect("switching the From account moves the provider's copy", () =>
    withMail((m, gmail, outlook) =>
      Effect.gen(function* () {
        yield* m.connect({ provider: "outlook" });
        yield* m.saveDraft({ id: "draft:1", accountId: GMAIL, message: draftMessage() });
        assert.strictEqual(gmail.drafts.size, 1);
        yield* m.saveDraft({ id: "draft:1", accountId: OUTLOOK, message: draftMessage() });
        assert.strictEqual(gmail.drafts.size, 0);
        assert.strictEqual(outlook.drafts.size, 1);
      }),
    ),
  );

  it.effect("preferences, signatures and templates are stored in core", () =>
    withMail((m) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* m.prefs, DEFAULT_PREFS);
        yield* m.setPrefs({ undoSendSeconds: 20, markReadDelay: "manual", threadGrouping: false });
        assert.deepStrictEqual(yield* m.prefs, {
          ...DEFAULT_PREFS,
          undoSendSeconds: 20,
          markReadDelay: "manual",
          threadGrouping: false,
        });

        yield* m.setSignature({ address: "Me@Gmail.com", kind: "new", text: "王\n产品部" });
        yield* m.setSignature({ address: "me@gmail.com", kind: "reply", text: "王" });
        assert.deepStrictEqual(yield* m.signatures, [
          { address: "me@gmail.com", kind: "new", text: "王\n产品部", html: "王<br>产品部" },
          { address: "me@gmail.com", kind: "reply", text: "王", html: "王" },
        ]);
        yield* m.setSignature({ address: "me@gmail.com", kind: "reply", text: " " });
        assert.strictEqual((yield* m.signatures).length, 1);

        const input = {
          name: "报价",
          subject: "报价单",
          to: [bob],
          cc: [],
          body: "{first_name} 你好",
        };
        const created = yield* m.saveTemplate(input);
        yield* m.saveTemplate({ ...input, name: "报价 v2" }, created.id);
        assert.deepStrictEqual(
          (yield* m.templates).map((t) => t.name),
          ["报价 v2"],
        );
        assert.strictEqual((yield* Effect.flip(m.saveTemplate(input, "missing")))._tag, "NotFound");
        yield* m.deleteTemplate(created.id);
        assert.deepStrictEqual(yield* m.templates, []);
      }),
    ),
  );

  it.effect(
    "recipient suggestions rank by frequency and recency, skipping hidden addresses and the sender",
    () =>
      withMail(
        (m) =>
          Effect.gen(function* () {
            yield* m.connect({ provider: "outlook" });
            const top = yield* m.suggestContacts("", { exclude: "Me@Gmail.com" });
            assert.deepStrictEqual(
              top.map((a) => a.address),
              ["carol@example.com", "alice@example.com", "dave@example.com", "me@outlook.com"],
            );
            // The person's other account is suggested; so is this one when not writing from it.
            assert.deepStrictEqual(
              (yield* m.suggestContacts("me@", { exclude: "me@gmail.com" })).map((a) => a.address),
              ["me@outlook.com"],
            );
            assert.deepStrictEqual(
              (yield* m.suggestContacts("me@", { exclude: "me@outlook.com" })).map(
                (a) => a.address,
              ),
              ["me@gmail.com"],
            );
            assert.strictEqual(top[0]?.name, "Carol Chen");
            assert.deepStrictEqual(
              (yield* m.suggestContacts("CHEN")).map((a) => a.address),
              ["carol@example.com"],
            );

            yield* m.setContactHidden("Alice@Example.com", true);
            assert.deepStrictEqual(yield* m.hiddenContacts, ["alice@example.com"]);
            assert.ok(
              !(yield* m.suggestContacts("")).some((a) => a.address === "alice@example.com"),
            );
            yield* m.setContactHidden("alice@example.com", false);
            assert.strictEqual((yield* m.suggestContacts("ali")).length, 1);
          }),
        [
          incoming("s1", {
            labels: ["SENT"],
            from: { name: "", address: "me@gmail.com" },
            to: [{ name: "Carol Chen", address: "Carol@example.com" }],
          }),
          incoming("s2", {
            labels: ["SENT"],
            from: { name: "", address: "me@gmail.com" },
            to: [{ name: "", address: "carol@example.com" }],
            cc: [{ name: "Me", address: "me@gmail.com" }],
          }),
          incoming("r1"),
          incoming("r2", { from: { name: "Dave", address: "dave@example.com" }, date: 1 }),
          incoming("o1", { from: { name: "Me", address: "me@outlook.com" } }),
          incoming("n1", { from: { name: "", address: "noreply@shop.com" } }),
          incoming("j1", { labels: ["SPAM"], from: { name: "", address: "spam@x.com" } }),
        ],
      ),
  );

  it.effect(
    "draft status treats missing local drafts as absence and never imports message ids",
    () =>
      withMail((mailbox, gmail) =>
        Effect.gen(function* () {
          const id = "draft:optional-status";
          assert.strictEqual(yield* mailbox.draftStatus(id), null);
          assert.strictEqual(yield* mailbox.draftStatus(`${GMAIL}/remote`), null);
          assert.deepStrictEqual(gmail.bodyFetched, []);
          assert.deepStrictEqual(gmail.draftLog, []);
          const saved = yield* mailbox.saveDraft({ id, accountId: GMAIL, message: draftMessage() });
          assert.deepStrictEqual(yield* mailbox.draftStatus(id), saved);
          yield* mailbox.discardDraft(id);
          assert.strictEqual(yield* mailbox.draftStatus(id), null);
          const missing = yield* mailbox.openDraft(id).pipe(Effect.flip);
          assert.strictEqual(missing._tag, "NotFound");
          if (missing._tag === "NotFound") assert.strictEqual(missing.what, "draft");
        }),
      ),
  );
}

{
  const accountId = "gmail:me@example.com";

  const message: OutgoingMessage = {
    to: [{ name: "John", address: "j@acme.com" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    text: "v1",
    attachments: [],
  };

  const incoming: IncomingMessage = buildIncoming("one", {
    threadId: "one",
    from: { name: "John", address: "j@acme.com" },
    to: [],
    subject: "Hello",
    bodyText: "Hello",
    date: 1,
    labels: ["INBOX"],
    isUnread: false,
  });

  function fixture<A, E>(
    body: (
      m: Mailbox["Service"],
      store: Store["Service"],
      server: FakeServer,
    ) => Effect.Effect<A, E, SqlClient.SqlClient>,
    wrap: (adapter: ProviderAdapter) => ProviderAdapter = (adapter) => adapter,
  ) {
    const server = fakeServer("me@example.com");
    const adapter = wrap(makeFakeProvider(server));
    return Effect.gen(function* () {
      const m = yield* Mailbox,
        store = yield* Store;
      yield* store.upsertAccount("gmail", server.email);
      return yield* body(m, store, server);
    }).pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, {
          options: { backgroundFlush: false },
          platformOptions: {},
        }),
      ),
    );
  }

  it.effect(
    "keeping local during a claimed push retains its remote ids and Retry updates the single cloud draft",
    () =>
      Effect.gen(function* () {
        const created = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        let calls = 0;
        yield* fixture(
          (m, store, server) =>
            Effect.gen(function* () {
              const saving = yield* Effect.forkChild(
                m.saveDraft({ id: "draft:race", accountId, message }),
              );
              yield* Deferred.await(created);
              yield* m.recoverDraft("draft:race", "local");
              assert.strictEqual((yield* store.listPendingOps).length, 1);
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(saving);
              const kept = yield* store.getDraft("draft:race");
              assert.ok(Option.isSome(kept));
              assert.ok(kept.value.remote?.draftId);
              assert.strictEqual(kept.value.localOnly, true);
              yield* m.recoverDraft("draft:race", "retry");
              assert.strictEqual(server.drafts.size, 1);
              const second = server.draftLog.filter((log) => log.kind === "save")[1];
              assert.strictEqual(second?.push.remote?.draftId, kept.value.remote.draftId);
            }),
          (adapter) => ({
            ...adapter,
            saveDraft: (account, push) =>
              adapter
                .saveDraft(account, push)
                .pipe(
                  Effect.tap(() =>
                    Effect.suspend(() =>
                      ++calls === 1
                        ? Deferred.succeed(created, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                          )
                        : Effect.void,
                    ),
                  ),
                ),
          }),
        );
      }),
  );

  it.effect("a push whose local draft is discarded deletes the newly created cloud copy", () =>
    Effect.gen(function* () {
      const created = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      yield* fixture(
        (m, store, server) =>
          Effect.gen(function* () {
            const saving = yield* Effect.forkChild(
              m.saveDraft({ id: "draft:discard", accountId, message }),
            );
            yield* Deferred.await(created);
            yield* store.deleteDraft("draft:discard");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(saving);
            assert.strictEqual(server.drafts.size, 0);
          }),
        (adapter) => ({
          ...adapter,
          saveDraft: (account, push) =>
            adapter
              .saveDraft(account, push)
              .pipe(
                Effect.tap(() =>
                  Deferred.succeed(created, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              ),
        }),
      );
    }),
  );

  it.effect("unchanged upserts and no-op labels do not rebuild contact candidates", () =>
    fixture((_m, store) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* store.upsertMessage(accountId, incoming);
        yield* sql`CREATE TABLE candidate_changes(count INTEGER)`;
        yield* sql`INSERT INTO candidate_changes VALUES(0)`;
        yield* sql`CREATE TRIGGER observe_contact_delete AFTER DELETE ON contact_candidates BEGIN UPDATE candidate_changes SET count=count+1; END`;
        yield* store.upsertMessage(accountId, incoming);
        yield* sql`UPDATE messages SET labels_json=labels_json WHERE provider_id='one'`;
        const [changes] = yield* sql`SELECT count FROM candidate_changes`;
        assert.strictEqual(changes?.count, 0);
        yield* store.upsertMessage(accountId, {
          ...incoming,
          from: { name: "Updated", address: "updated@acme.com" },
        });
        assert.strictEqual(
          (yield* store.suggestContacts("updated acme", 10))[0]?.address,
          "updated@acme.com",
        );
        assert.deepStrictEqual(yield* store.suggestContacts("john acme", 10), []);
      }),
    ),
  );

  it("migration 23 safely indexes mixed/empty recipients already stored by migration 22", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmail-signatures-fixes-"));
    const db = new DatabaseSync(join(directory, "mail.db"));
    try {
      const migration23 = MIGRATIONS[22];
      assert.ok(migration23);
      for (const migration of MIGRATIONS.slice(0, 22)) applyNativeMigration(db, migration);
      db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
        accountId,
        "gmail",
        "me@example.com",
        0,
      );
      db.prepare(
        "INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        "one",
        accountId,
        "one",
        "one",
        "Hello",
        "Me",
        "me@example.com",
        JSON.stringify([
          "broken",
          null,
          {},
          { address: "" },
          { address: " " },
          { address: "John@Acme.Com", name: "John" },
        ]),
        "[]",
        1,
        "",
        "",
        "",
        '["SENT"]',
        "[]",
        0,
        0,
      );
      db.exec(migration23);
      assert.deepStrictEqual(
        db
          .prepare("SELECT DISTINCT address FROM contact_candidates WHERE source=2")
          .all()
          .map((row) => row.address),
        ["john@acme.com"],
      );
      db.exec(
        'UPDATE messages SET to_json=\'[null,{},"broken",{"address":""},{"address":"jane@acme.com","name":"Jane"}]\' WHERE id=\'one\'',
      );
      assert.deepStrictEqual(
        db
          .prepare("SELECT DISTINCT address FROM contact_candidates WHERE source=2")
          .all()
          .map((row) => row.address),
        ["jane@acme.com"],
      );
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.effect(
    "deleting a chosen signature restores Gmail fallback while explicit None stays None",
    () =>
      fixture((m, store) =>
        Effect.gen(function* () {
          yield* store.replaceSendAs(accountId, [
            {
              accountId,
              address: "me@example.com",
              name: "Me",
              isDefault: true,
              signature: "Gmail",
            },
          ]);
          const local = yield* m.saveNamedSignature({
            address: "me@example.com",
            name: "Local",
            text: "Local",
          });
          yield* m.setSignatureDefault({
            address: local.address,
            kind: "new",
            signatureId: local.id,
          });
          yield* m.setSignatureDefault({
            address: local.address,
            kind: "reply",
            signatureId: null,
          });
          yield* m.deleteNamedSignature(local.id);
          assert.strictEqual((yield* m.signatures).find((s) => s.kind === "new")?.text, "Gmail");
          assert.ok(!(yield* m.signatures).some((s) => s.kind === "reply"));
        }),
      ),
  );

  it("replying to one's own Sent message retains its verified From ahead of recipients", () => {
    const aliases = [
      { accountId, address: "alias@example.com", name: "Alias", isDefault: false, signature: "" },
    ];
    const sent = {
      from: { name: "Alias", address: "alias@example.com" },
      to: [{ name: "", address: "me@example.com" }],
      cc: [],
      labels: ["SENT"],
    };
    assert.strictEqual(
      replyFromAddress(sent, { id: accountId, email: "me@example.com" }, aliases, "received")
        .address,
      "alias@example.com",
    );
    assert.strictEqual(
      replyFromAddress(sent, { id: accountId, email: "me@example.com" }, aliases, "default")
        .address,
      "me@example.com",
    );
  });

  it.effect("Retry atomically saves current edits while an earlier push is still claimed", () =>
    Effect.gen(function* () {
      const created = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      let count = 0;
      yield* fixture(
        (m, store, server) =>
          Effect.gen(function* () {
            const saving = yield* Effect.forkChild(
              m.saveDraft({ id: "draft:retry-race", accountId, message }),
            );
            yield* Deferred.await(created);
            const retry = yield* Effect.forkChild(
              m.recoverDraft("draft:retry-race", "retry", {
                id: "draft:retry-race",
                accountId,
                message: { ...message, text: "Current edits" },
              }),
            );
            yield* Effect.yieldNow;
            // The old claimed push remains owned; recovery never passes through local-only.
            const current = yield* store.getDraft("draft:retry-race");
            assert.ok(Option.isSome(current));
            assert.strictEqual(current.value.localOnly, false);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(saving);
            const result = yield* Fiber.join(retry);
            assert.strictEqual(result.message.text, "Current edits");
            assert.strictEqual(result.synced, true);
            assert.strictEqual(server.drafts.size, 1);
            assert.strictEqual([...server.drafts.values()][0]?.push.message.text, "Current edits");
          }),
        (adapter) => ({
          ...adapter,
          saveDraft: (account, push) =>
            adapter
              .saveDraft(account, push)
              .pipe(
                Effect.tap(() =>
                  Effect.suspend(() =>
                    ++count === 1
                      ? Deferred.succeed(created, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                        )
                      : Effect.void,
                  ),
                ),
              ),
        }),
      );
    }),
  );

  it.effect(
    "a late push after changing accounts deletes its cloud copy instead of attaching it to the new account",
    () =>
      Effect.gen(function* () {
        const created = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        yield* fixture(
          (m, store, server) =>
            Effect.gen(function* () {
              const saving = yield* Effect.forkChild(
                m.saveDraft({ id: "draft:moved", accountId, message }),
              );
              yield* Deferred.await(created);
              const other = yield* store.upsertAccount("outlook", "other@example.com");
              yield* store.putDraft({ id: "draft:moved", accountId: other.id, message });
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(saving);
              assert.strictEqual(server.drafts.size, 0);
              const moved = yield* store.getDraft("draft:moved");
              assert.ok(Option.isSome(moved));
              assert.strictEqual(moved.value.remote, null);
            }),
          (adapter) => ({
            ...adapter,
            saveDraft: (account, push) =>
              adapter
                .saveDraft(account, push)
                .pipe(
                  Effect.tap(() =>
                    Deferred.succeed(created, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                ),
          }),
        );
      }),
  );

  it.effect(
    "transient draft failures stay recoverable past five retries and expire after a week",
    () =>
      fixture(
        (m) =>
          Effect.gen(function* () {
            for (let attempt = 1; attempt <= 8; attempt++) {
              if (attempt > 1) yield* TestClock.adjust("1 hour");
              yield* attempt === 1
                ? m.saveDraft({ id: "draft:attempts", accountId, message })
                : m.sync();
              const draft = yield* m.openDraft("draft:attempts");
              assert.strictEqual(draft.syncRetrying, true);
              assert.strictEqual(draft.syncError, "Private network detail");
              assert.strictEqual(draft.message.text, message.text);
            }
            yield* TestClock.adjust("8 days");
            yield* m.sync();
            assert.strictEqual((yield* m.openDraft("draft:attempts")).syncRetrying, false);
            assert.strictEqual((yield* m.listFailedOps).length, 1);
          }),
        (adapter) => ({
          ...adapter,
          saveDraft: () => Effect.fail(new ProviderError({ message: "Private network detail" })),
        }),
      ),
  );

  it.effect("remote acknowledgements retain local-only error bookkeeping", () =>
    fixture((_m, store) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* store.putDraft({ id: "draft:bookkeeping", accountId, message });
        yield* store.setDraftLocalOnly("draft:bookkeeping", true);
        yield* sql`UPDATE drafts SET sync_error='Preserved diagnostic' WHERE id='draft:bookkeeping'`;
        assert.strictEqual(
          yield* store.setDraftRemote(
            "draft:bookkeeping",
            { draftId: "remote", messageId: "message" },
            "attachments",
            accountId,
          ),
          true,
        );
        const draft = yield* store.getDraft("draft:bookkeeping");
        assert.ok(Option.isSome(draft));
        assert.strictEqual(draft.value.syncError, "Preserved diagnostic");
        assert.deepStrictEqual(draft.value.remote, { draftId: "remote", messageId: "message" });
      }),
    ),
  );

  it("signature insertion and switching preserve main's compose font metadata", () => {
    const body = { ...richComposeBody("Body"), font: DEFAULT_PREFS.composeFont };
    const first = { text: "First" },
      second = { text: "Second" };
    const signed = applyComposeSignature(body, undefined, first),
      switched = applyComposeSignature(signed, first, second);
    const removed = applyComposeSignature(switched, second, undefined);
    for (const result of [signed, switched, removed]) {
      assert.ok(result.kind === "rich");
      assert.deepStrictEqual(result.font, body.font);
    }
  });

  it.effect(
    "changing From accounts keeps a local copy local and leaves the old server draft untouched",
    () => {
      const gmail = fakeServer("me@example.com"),
        outlook = fakeServer("other@example.com");
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const originalAccount = yield* mailbox.connect({ provider: "gmail" });
        const newAccount = yield* mailbox.connect({ provider: "outlook" });
        const saved = yield* mailbox.saveDraft({
          id: "draft:local-account-change",
          accountId: originalAccount.id,
          message,
        });
        yield* mailbox.sync();
        const oldCloudDrafts = [...gmail.drafts.entries()];
        const oldLogLength = gmail.draftLog.length;
        assert.strictEqual(oldCloudDrafts.length, 1);
        yield* mailbox.recoverDraft(saved.id, "local");
        const changed = yield* mailbox.saveDraft({
          id: saved.id,
          accountId: newAccount.id,
          message: { ...message, text: "Local edits after changing From" },
        });
        yield* mailbox.sync();
        const reopened = yield* mailbox.openDraft(saved.id);
        assert.deepStrictEqual(
          {
            returnedLocal: changed.localOnly,
            storedLocal: reopened.localOnly,
            oldCloudCount: gmail.drafts.size,
            newCloudCount: outlook.drafts.size,
          },
          { returnedLocal: true, storedLocal: true, oldCloudCount: 1, newCloudCount: 0 },
        );
        assert.strictEqual(reopened.accountId, newAccount.id);
        assert.strictEqual(reopened.message.text, "Local edits after changing From");
        assert.deepStrictEqual([...gmail.drafts.entries()], oldCloudDrafts);
        assert.strictEqual(gmail.draftLog.length, oldLogLength);
        assert.strictEqual(outlook.draftLog.length, 0);
      }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
    },
  );
}
