import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { simpleParser } from "mailparser";

import { buildMime } from "./compose.js";
import { type Actor, DEFAULT_PREFS, type IncomingMessage, type OutgoingMessage } from "./domain.js";
import { ProviderError } from "./errors.js";
import { Mailbox } from "./mailbox.js";
import { type FakeServer, fakeServer, TestMailbox } from "./testing.js";

const GMAIL = "gmail:me@gmail.com";
const OUTLOOK = "outlook:me@outlook.com";
const user: Actor = { kind: "user", surface: "app" };
const agent: Actor = { kind: "agent", surface: "mcp", name: "claude", rationale: "asked" };

function incoming(providerId: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    providerId,
    threadId: `t-${providerId}`,
    subject: `主题 ${providerId}`,
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "", address: "me@gmail.com" }],
    cc: [],
    date: 1_000,
    snippet: "",
    bodyText: "你好",
    bodyHtml: "",
    labels: ["INBOX"],
    attachments: [],
    isUnread: false,
    isStarred: false,
    ...overrides,
  };
}

const bob = { name: "Bob", address: "bob@example.com" };

function draftMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return { to: [bob], cc: [], bcc: [], subject: "计划", text: "v1", attachments: [], ...overrides };
}

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

it.effect("a draft saved offline stays local and goes out with the next sync", () =>
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
      yield* m.decideProposal(second.status === "proposed" ? second.proposalId : -1, false, "app");
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
            (yield* m.suggestContacts("me@", { exclude: "me@outlook.com" })).map((a) => a.address),
            ["me@gmail.com"],
          );
          assert.strictEqual(top[0]?.name, "Carol Chen");
          assert.deepStrictEqual(
            (yield* m.suggestContacts("CHEN")).map((a) => a.address),
            ["carol@example.com"],
          );

          yield* m.setContactHidden("Alice@Example.com", true);
          assert.deepStrictEqual(yield* m.hiddenContacts, ["alice@example.com"]);
          assert.ok(!(yield* m.suggestContacts("")).some((a) => a.address === "alice@example.com"));
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
