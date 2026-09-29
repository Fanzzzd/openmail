import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import type { Actor, IncomingMessage } from "./domain.js";
import { AuthError, ProviderError } from "./errors.js";
import { Mailbox } from "./mailbox.js";
import { toModelThread } from "./model-view.js";
import { fakeServer, TestMailbox } from "./testing.js";

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
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    isUnread: true,
    isStarred: false,
    ...overrides,
  };
}

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
      assert.strictEqual(applied.status, "applied");
      assert.strictEqual((yield* m.audit(1))[0]?.actor, "agent:mcp:claude");
    }),
  ),
);

it.effect("an agent's message waits for a person; a person's reply carries the original", () =>
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
      const proposed = yield* m.perform({ kind: "send", accountId, message }, agent);
      assert.strictEqual(proposed.status, "proposed");
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
        loginHint: server.email,
      });
      yield* m.sync();
      assert.deepStrictEqual(server.pushed, [
        { providerId: "m1", op: { kind: "read", value: true } },
      ]);
    }),
  ),
);

it.effect("a transient push failure retries on the next sync", () =>
  withGmail([incoming("m1")], (m, server) =>
    Effect.gen(function* () {
      const [thread] = yield* m.threads({});
      server.failNext = new ProviderError({ message: "503" });
      yield* m.perform(
        { kind: "modify", threads: [thread!.id], op: { kind: "star", value: true } },
        user,
      );
      assert.strictEqual(server.pushed.length, 0);
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
