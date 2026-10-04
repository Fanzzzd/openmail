import {
  incoming as makeIncoming,
  incoming,
  fakeServer,
  TestMailbox,
} from "./platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { type Actor, type IncomingMessage, type Message } from "./domain.js";
import { AuthError, PermanentError, ProviderError } from "./errors.js";
import { Mailbox } from "./mailbox.js";
import { toModelThread } from "./model-view.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { Store, type ProviderAdapter } from "./services.js";
{
  const user: Actor = { kind: "user", surface: "app" };

  const agent: Actor = { kind: "agent", surface: "mcp", name: "claude", rationale: "newsletter" };

  /**
   * Connects the fake Gmail account, syncs, and runs `body` with the Mailbox.
   * Each test gets its own TestMailbox: the fake server records what one test
   * pushed and sent.
   */
  function withGmail<A, E>(
    messages: IncomingMessage[],
    body: (m: Mailbox["Service"], server: ReturnType<typeof fakeServer>) => Effect.Effect<A, E>,
  ) {
    const server = fakeServer("me@gmail.com", messages);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      return yield* body(mailbox, server);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  }

  it.effect("a person's archive changes local labels, reaches the provider and is audited", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        const [thread] = yield* m.threads({ mailbox: "inbox" });
        assert.ok(thread);
        const outcome = yield* m.perform(
          { kind: "modify", threads: [thread.id], op: { kind: "archive" } },
          user,
        );
        assert.strictEqual(outcome.status, "applied");
        assert.deepStrictEqual(yield* m.threads({ mailbox: "inbox" }), []);
        assert.deepStrictEqual(server.pushed, [{ providerId: "m1", op: { kind: "archive" } }]);
        const [entry] = yield* m.audit(10);
        assert.ok(entry);
        assert.strictEqual(entry.action, "archive");
        assert.strictEqual(entry.actor, "user:app");
      }),
    ),
  );

  it.effect("agents are read-only until allowed; proposals run only when a person approves", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        const [thread] = yield* m.threads({});
        const archive = { kind: "modify", threads: [thread!.id], op: { kind: "archive" } } as const;

        const denied = yield* m.perform(archive, agent);
        assert.strictEqual(denied.status, "denied");
        assert.strictEqual(server.pushed.length, 0);

        yield* m.setAgentWriteMode("propose");
        const proposed = yield* m.perform(archive, agent);
        assert.strictEqual(proposed.status, "proposed");
        assert.strictEqual(server.pushed.length, 0);
        const [proposal] = yield* m.proposals;
        assert.strictEqual(
          proposal?.actor.kind === "agent" && proposal.actor.rationale,
          "newsletter",
        );

        yield* m.decideProposal(proposal!.id, true, "app");
        assert.strictEqual(server.pushed.length, 1);
        assert.deepStrictEqual(yield* m.proposals, []);

        yield* m.setAgentWriteMode("allow");
        const applied = yield* m.perform(
          { kind: "modify", threads: [thread!.id], op: { kind: "star", value: true } },
          agent,
        );
        assert.strictEqual(applied.status, "proposed");
        assert.strictEqual((yield* m.audit(1))[0]?.actor, "agent:mcp:claude");
      }),
    ),
  );

  it.effect("MCP cannot propose a send; a person's reply carries the original", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        const [thread] = yield* m.threads({});
        const message = {
          to: [{ name: "", address: "alice@example.com" }],
          cc: [],
          bcc: [],
          subject: "Re: 主题 m1",
          text: "收到",
          attachments: [],
          inReplyTo: thread!.id,
          mode: "reply",
        } as const;
        const accountId = thread!.accountId;

        // Even with writes allowed, an agent never sends.
        yield* m.setAgentWriteMode("allow");
        const denied = yield* m.perform({ kind: "send", accountId, message }, agent);
        assert.strictEqual(denied.status, "denied");
        assert.strictEqual(server.sent.length, 0);

        yield* m.perform({ kind: "send", accountId, message }, user);
        assert.strictEqual(server.sent.length, 1);
        const original = server.sent[0]!.original;
        assert.strictEqual(original._tag === "Some" && original.value.providerId, "m1");
      }),
    ),
  );

  it.effect("an auth failure pauses the account and keeps the change queued", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        const [thread] = yield* m.threads({});
        server.failNext = new AuthError({ accountId: thread!.accountId, message: "revoked" });
        const outcome = yield* m.perform(
          { kind: "modify", threads: [thread!.id], op: { kind: "read", value: true } },
          user,
        );
        assert.strictEqual(outcome.status === "applied" && outcome.flush?.reauth.length, 1);
        const [account] = yield* m.accounts;
        assert.strictEqual(account?.needsReauth, true);
        // Local state changed anyway.
        assert.strictEqual((yield* m.thread(thread!.id))[0]?.isUnread, false);

        const [result] = yield* m.sync();
        assert.strictEqual(result?.needsReauth, true);
        assert.strictEqual(server.pushed.length, 0);

        // Signing in again names the account to the consent page, clears the
        // flag, and the queued change goes out.
        yield* m.reauth(account!.id);
        assert.deepStrictEqual(server.connects.at(-1), {
          provider: "gmail",
          grantedScopes: server.grantedScopes,
          loginHint: server.email,
        });
        yield* m.sync();
        assert.deepStrictEqual(server.pushed, [
          { providerId: "m1", op: { kind: "read", value: true } },
        ]);
      }),
    ),
  );

  it.effect("a transient push failure retries after backoff on the next sync", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        const [thread] = yield* m.threads({});
        server.failNext = new ProviderError({ message: "503" });
        yield* m.perform(
          { kind: "modify", threads: [thread!.id], op: { kind: "star", value: true } },
          user,
        );
        assert.strictEqual(server.pushed.length, 0);
        yield* TestClock.adjust("5 seconds");
        yield* m.sync();
        assert.strictEqual(server.pushed.length, 1);
      }),
    ),
  );

  it.effect("a pull that fails on the network is tried again and the sync succeeds", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        server.messages.set("m2", incoming("m2"));
        server.failNext = new ProviderError({
          message: "Gmail API 0: Transport error (GET /labels)",
        });
        const fiber = yield* Effect.forkChild(m.sync());
        yield* TestClock.adjust("5 seconds");
        const [result] = yield* Fiber.join(fiber);
        assert.strictEqual(result?.error, undefined);
        assert.deepStrictEqual((yield* m.syncState).errors, []);
        assert.strictEqual((yield* m.accounts)[0]?.lastSyncError, null);
        assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, 2);
      }),
    ),
  );

  it.effect("a pull the provider refuses fails the sync without waiting", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        server.failNext = new ProviderError({ message: "Gmail API 400: bad", status: 400 });
        const [result] = yield* m.sync();
        assert.strictEqual(result?.error, "Gmail API 400: bad");
        assert.strictEqual((yield* m.accounts)[0]?.lastSyncError, "Gmail API 400: bad");
      }),
    ),
  );

  it.effect("concurrent syncs share one run", () =>
    withGmail([incoming("m1")], (m) =>
      Effect.gen(function* () {
        const [a, b] = yield* Effect.all([m.sync(), m.sync()], { concurrency: 2 });
        assert.strictEqual(a, b);
      }),
    ),
  );

  it("threads for models drop quoted history and keep the newest text in budget", () => {
    const base = {
      accountId: "gmail:me@gmail.com",
      threadId: "t",
      subject: "报价",
      from: { name: "Alice", address: "alice@example.com" },
      to: [],
      cc: [],
      snippet: "",
      bodyHtml: "",
      labels: ["INBOX"],
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      attachments: [],
    };
    const thread = toModelThread(
      [
        { ...base, id: "a", date: 1, bodyText: "第一封，很长的内容".repeat(20) },
        {
          ...base,
          id: "b",
          date: 2,
          bodyText: "好的，就这么定。\n\n2026年9月1日 Alice 写道：\n> 第一封\n",
        },
      ],
      30,
    );
    assert.strictEqual(thread.messages[1]?.text, "好的，就这么定。");
    assert.ok(thread.truncated > 0);
    assert.ok(thread.messages[0]!.text.length <= 30);
  });

  const RELATED = [
    "From: Alice <alice@example.com>",
    "To: me@gmail.com",
    "Subject: Logo",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix"',
    "",
    "--mix",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Hi <img src="cid:logo@x"></p>',
    "--rel",
    "Content-Type: image/png",
    "Content-ID: <logo@x>",
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgo=",
    "--rel--",
    "--mix",
    'Content-Type: text/plain; name="报价.txt"',
    'Content-Disposition: attachment; filename="报价.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("价格表").toString("base64"),
    "--mix",
    'Content-Type: text/plain; name="报价.txt"',
    'Content-Disposition: attachment; filename="报价.txt"',
    "",
    "second copy",
    "--mix--",
    "",
  ].join("\r\n");

  it.effect("reads original source, attachments and inline images from the provider", () => {
    const listed = { filename: "报价.txt", mimeType: "text/plain", size: 9 };
    return withGmail(
      [incoming("m1", { bodyHtml: '<img src="cid:logo@x">', attachments: [listed, listed] })],
      (m, server) =>
        Effect.gen(function* () {
          server.raw.set("m1", new TextEncoder().encode(RELATED));
          const [thread] = yield* m.threads({});
          const id = thread!.id;

          const raw = yield* m.rawMessage(id);
          assert.include(raw, "Subject: Logo");

          const first = yield* m.attachment(id, 0);
          assert.strictEqual(first.filename, "报价.txt");
          assert.strictEqual(new TextDecoder().decode(first.data), "价格表");
          const second = yield* m.attachment(id, 1);
          assert.strictEqual(new TextDecoder().decode(second.data), "second copy");
          const missing = yield* Effect.flip(m.attachment(id, 2));
          assert.strictEqual(missing._tag, "NotFound");

          const inline = yield* m.inlineImages(id);
          assert.deepStrictEqual(Object.keys(inline), ["logo@x"]);
          assert.match(inline["logo@x"] ?? "", /^data:image\/png;base64,/);
          server.raw.delete("m1");
          assert.deepStrictEqual(yield* m.inlineImages(id), inline);
        }),
    );
  });

  it.effect("the remote image allowlist stores addresses and domains in lower case", () =>
    withGmail([], (m) =>
      Effect.gen(function* () {
        yield* m.setImageSender("News@Shop.com", true);
        yield* m.setImageSender("@Example.ORG", true);
        yield* m.setImageSender("  ", true);
        assert.deepStrictEqual(yield* m.imageSenders, ["example.org", "news@shop.com"]);
        yield* m.setImageSender("EXAMPLE.org", false);
        assert.deepStrictEqual(yield* m.imageSenders, ["news@shop.com"]);
      }),
    ),
  );

  for (const gone of [false, true])
    it.effect(`dropped optimistic ops restore server truth, gone=${gone}`, () =>
      withGmail([incoming("m1")], (m, server) =>
        Effect.gen(function* () {
          server.failNext = new PermanentError({ message: "Refused" });
          if (gone) server.messages.delete("m1");
          yield* m.perform(
            { kind: "modify", threads: ["gmail:me@gmail.com/m1"], op: { kind: "archive" } },
            user,
          );
          assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, gone ? 0 : 1);
          assert.ok((yield* m.audit(10)).some((entry) => entry.action === "sync-failed"));
        }),
      ),
    );

  it.effect("repeated transient push failures preserve optimistic state", () =>
    withGmail([incoming("m1")], (m, server) =>
      Effect.gen(function* () {
        server.beforePush = Effect.fail(new ProviderError({ message: "Refused repeatedly" }));
        yield* m.perform(
          { kind: "modify", threads: ["gmail:me@gmail.com/m1"], op: { kind: "archive" } },
          user,
        );
        for (let attempt = 0; attempt < 4; attempt++) yield* m.sync();
        assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, 0);
        assert.isFalse((yield* m.audit(10)).some((entry) => entry.action === "sync-failed"));
      }),
    ),
  );
}

{
  const message: IncomingMessage = makeIncoming("old", {
    threadId: "old",
    subject: "Old mail",
    from: { name: "Sender", address: "sender@example.com" },
    to: [],
    snippet: "text",
    bodyText: "full body",
  });

  const outgoing = {
    to: [{ name: "", address: "bob@example.com" }],
    cc: [],
    bcc: [],
    subject: "Test",
    text: "Hello",
    attachments: [],
  };

  const user = { kind: "user", surface: "app" } as const;

  function core<A, E>(
    body: Effect.Effect<A, E, Mailbox | Store>,
    overrides: Partial<ProviderAdapter> = {},
  ) {
    const server = fakeServer("me@gmail.com", [message]);
    const adapter = { ...makeFakeProvider(server), ...overrides };

    return body.pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, { options: { backgroundFlush: false, imapIdle: false } }),
      ),
    );
  }

  it.effect("label-only history hydrates missing local mail", () =>
    core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        assert.strictEqual((yield* store.getMessage(`${account.id}/old`)).bodyText, "full body");
      }),
      {
        pull: () =>
          Stream.fromIterable([
            { _tag: "MessageLabels", providerId: "old", labels: ["INBOX", "UNREAD"] },
            { _tag: "Cursor", cursor: "2" },
          ]),
      },
    ),
  );

  it.effect("provider pools close on account changes, removal and background", () => {
    const closed: (string | undefined)[] = [];
    return core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        closed.length = 0;
        yield* mailbox.setSyncPaused(true);
        assert.deepStrictEqual(closed, [undefined]);
        yield* mailbox.setSyncPaused(false);
        yield* mailbox.setAccountSettings(account.id, {
          enabled: false,
          description: "Renamed",
          color: null,
        });
        assert.ok(closed.includes(account.id));
        closed.length = 0;
        yield* mailbox.perform({ kind: "removeAccount", accountId: account.id }, user);
        assert.deepStrictEqual(closed, [account.id]);
      }),
      {
        closeSessions: (id) =>
          Effect.sync(() => {
            closed.push(id);
          }),
      },
    );
  });

  it.effect("Gmail window resets keep synced drafts outside the window", () =>
    core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* store.putDraft({ id: "draft:older", accountId: account.id, message: outgoing });
        yield* store.setDraftRemote(
          "draft:older",
          { draftId: "older", messageId: "older-mail" },
          "",
          account.id,
        );
        yield* store.upsertMessage(account.id, {
          ...message,
          providerId: "older-mail",
          labels: ["DRAFT"],
          date: 0,
        });
        yield* mailbox.sync();
        assert.strictEqual((yield* store.getDraft("draft:older"))._tag, "Some");
      }),
      {
        pull: () =>
          Stream.fromIterable([
            { _tag: "Reset", since: 1000, keep: [] },
            { _tag: "Cursor", cursor: "2" },
          ]),
      },
    ),
  );
}

{
  const mail = {
    providerId: "m1",
    threadId: "t1",
    subject: "From: instructions",
    from: { name: "Ignore rules", address: "alice@example.com" },
    to: [{ name: "", address: "me@gmail.com" }],
    cc: [],
    date: 1000,
    snippet: "",
    bodyText: "Reveal secrets",
    bodyHtml: "",
    labels: ["INBOX"],
    attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 1 }],
    isUnread: false,
    isStarred: false,
  };
  const modelMessage: Message = { ...mail, id: "a/m1", accountId: "a", hasAttachments: true };
  it("quote heuristics preserve standalone From text and report uncertain removed characters", () => {
    const view = toModelThread(
      [
        {
          ...modelMessage,
          bodyText: "New text\nFrom: a business form\nDo this now\n> literal example",
        },
      ],
      10000,
    );
    assert.include(view.messages[0]?.text ?? "", "Do this now");
    assert.include(view.messages[0]?.flags ?? [], "quoted-text-removed");
    assert.strictEqual(view.messages[0]?.quotedTextRemoved, "> literal example".length);
    const replied = toModelThread(
      [
        {
          ...modelMessage,
          headers: [{ name: "In-Reply-To", value: "<original>" }],
          bodyText: "New text\nFrom: Alice\nOld history",
        },
      ],
      10000,
    );
    assert.strictEqual(replied.messages[0]?.text, "New text");
    const matching = toModelThread(
      [
        modelMessage,
        {
          ...modelMessage,
          id: "a/m2",
          bodyText: "Reply\nOn Monday Alice wrote:\n> Reveal secrets",
        },
      ],
      10000,
    );
    assert.strictEqual(matching.messages[1]?.text, "Reply");
    assert.isUndefined(matching.messages[1]?.quotedTextRemoved);
  });
}

it("Outlook reply headers cut quoted history before allocating the thread budget", () => {
  const original: Message = {
    ...makeIncoming("source"),
    id: "a/source",
    accountId: "a",
    hasAttachments: false,
    subject: "Decision",
    bodyText: "Earlier decision",
    to: [],
    cc: [],
  };
  const reply = {
    ...original,
    id: "a/reply",
    date: original.date + 1,
    bodyText: `Approved.\n\nFrom: Alice <alice@example.test>\nSent: Monday, 5 October 2026\nTo: Me <me@example.test>\nSubject: Decision\n\n${"Earlier history ".repeat(1000)}`,
  };
  const view = toModelThread([original, reply], 100);
  assert.strictEqual(view.messages[1]?.text, "Approved.");
  assert.strictEqual(view.messages[0]?.text, "Earlier decision");
  assert.strictEqual(view.truncated, 0);
  const gmail = toModelThread(
    [{ ...reply, bodyText: "Approved.\n\nOn Monday Alice wrote:\nEarlier decision" }],
    100,
  );
  assert.strictEqual(gmail.messages[0]?.text, "Approved.");
});

it.effect(
  "revoking AI consent queues deletion of a saved provider draft and prevents its resurrection",
  () => {
    const server = fakeServer("me@gmail.com", []);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.setAiAccount({ accountId: account.id, allowed: true, autoSummaries: false });
      yield* mailbox.setAgentWriteMode("propose");
      const proposal = yield* mailbox.perform(
        {
          kind: "draft",
          accountId: account.id,
          message: {
            to: [{ name: "", address: "new@example.test" }],
            cc: [],
            bcc: [],
            subject: "AI draft",
            text: "Proposal",
            attachments: [],
          },
        },
        { kind: "agent", surface: "mcp", name: "client" },
      );
      assert.ok(proposal.status === "proposed");
      const draft = yield* mailbox.openDraft(`proposal:${proposal.proposalId}`);
      yield* mailbox.saveDraft(draft);
      assert.strictEqual(server.drafts.size, 1);
      // Simulate a temporary provider failure. The delete intent must remain durable.
      server.failNext = new ProviderError({ message: "Offline", deferred: true });
      yield* mailbox.setAiAccount({ accountId: account.id, allowed: false, autoSummaries: false });
      assert.isNull(yield* mailbox.draftStatus(draft.id));
      assert.ok((yield* store.listPendingOps).some((op) => op.op.kind === "deleteDraft"));
      yield* mailbox.sync(account.id);
      assert.deepStrictEqual(yield* mailbox.threads({ mailbox: "drafts" }), []);
      yield* TestClock.adjust("10 minutes");
      yield* mailbox.sync(account.id);
      assert.strictEqual(server.drafts.size, 0);
      assert.strictEqual(server.draftLog.filter((entry) => entry.kind === "delete").length, 1);
      assert.deepStrictEqual(yield* mailbox.threads({ mailbox: "drafts" }), []);
      assert.deepStrictEqual(yield* mailbox.proposals, []);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

for (const provider of ["outlook", "gmail"] as const) {
  it.effect(
    `Mailbox.perform rejects copy for ${provider} before any queued mutation, including mixed targets`,
    () => {
      let pushes = 0;
      const adapter = {
        ...makeFakeProvider(fakeServer("me@example.test")),
        push: () =>
          Effect.sync(() => {
            pushes++;
          }),
      };
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const imap = yield* store.upsertAccount("imap", "me@example.test");
        const unsupported = yield* store.upsertAccount(provider, "me@example.test");
        yield* store.upsertMessage(imap.id, incoming("1:1:INBOX"));
        yield* store.upsertMessage(unsupported.id, incoming("one"));
        const imapId = `${imap.id}/1:1:INBOX`;
        const unsupportedId = `${unsupported.id}/one`;
        for (const targets of [[unsupportedId], [imapId, unsupportedId]]) {
          const result = yield* mailbox
            .perform(
              { kind: "modify", threads: targets, op: { kind: "copy", labelIds: ["Projects"] } },
              { kind: "user", surface: "app" },
            )
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.strictEqual(result.failure._tag, "InvalidInput");
            assert.strictEqual(
              result.failure.message,
              "This organization action is unavailable for this account.",
            );
          }
          assert.deepStrictEqual(yield* store.listPendingOps, []);
          assert.deepStrictEqual(yield* mailbox.listFailedOps, []);
          assert.strictEqual(pushes, 0);
        }
      }).pipe(
        Effect.provide(
          TestMailbox.withAdapter(adapter, {
            options: { backgroundFlush: false, imapIdle: false },
          }),
        ),
      );
    },
  );
}
