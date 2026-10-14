import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "../store/service.js";

it.effect("sync(B) during a running sync(A) waits for A and then syncs B", () => {
  const gmail = fakeServer("me@gmail.com");
  const outlook = fakeServer("me@outlook.com");
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const a = yield* m.accounts.connect({ provider: "gmail" });
    const b = yield* m.accounts.connect({ provider: "outlook" });
    yield* m.sync.sync();
    outlook.messages.set("new", {
      providerId: "new",
      threadId: "t",
      subject: "B mail",
      from: { name: "", address: "x@example.com" },
      to: [],
      cc: [],
      date: 5000,
      snippet: "",
      bodyText: "b",
      bodyHtml: "<p>b</p>",
      labels: ["inbox"],
      attachments: [],
      isUnread: true,
      isStarred: false,
    });
    const fa = yield* Effect.forkChild(m.sync.sync(a.id));
    const fb = yield* Effect.forkChild(m.sync.sync(b.id));
    const ra = yield* Fiber.join(fa);
    const rb = yield* Fiber.join(fb);
    assert.deepStrictEqual(
      ra.map((r) => r.accountId),
      [a.id],
    );
    assert.deepStrictEqual(
      rb.map((r) => r.accountId),
      [b.id],
    );
    assert.isAbove(rb[0]?.changed ?? 0, 0, "B's new message was pulled");
  }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
});

it.effect("sync(A) during a running full sync joins it and returns only A's row", () => {
  const gmail = fakeServer("me@gmail.com");
  const outlook = fakeServer("me@outlook.com");
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const a = yield* m.accounts.connect({ provider: "gmail" });
    yield* m.accounts.connect({ provider: "outlook" });
    const all = yield* Effect.forkChild(m.sync.sync());
    const one = yield* Effect.forkChild(m.sync.sync(a.id));
    assert.strictEqual((yield* Fiber.join(all)).length, 2);
    assert.deepStrictEqual(
      (yield* Fiber.join(one)).map((r) => r.accountId),
      [a.id],
    );
  }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
});

it.live("an account connected during a running full sync is synced after that run", () => {
  const gmail = fakeServer("me@gmail.com");
  const outlook = fakeServer("me@outlook.com");
  outlook.messages.set("o1", {
    providerId: "o1",
    threadId: "t",
    subject: "Outlook mail",
    from: { name: "", address: "x@example.com" },
    to: [],
    cc: [],
    date: 5000,
    snippet: "",
    bodyText: "b",
    bodyHtml: "<p>b</p>",
    labels: ["inbox"],
    attachments: [],
    isUnread: true,
    isStarred: false,
  });
  const entered = Deferred.makeUnsafe<void>();
  const gate = Deferred.makeUnsafe<void>();
  const state = { gated: false };
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const store = yield* Store;
    yield* m.accounts.connect({ provider: "gmail" });
    yield* m.sync.sync();
    state.gated = true;
    const all = yield* Effect.forkChild(m.sync.sync());
    // The full run has listed its accounts and is pulling Gmail.
    yield* Deferred.await(entered);
    const o = yield* m.accounts.connect({ provider: "outlook" });
    const one = yield* Effect.forkChild(m.sync.sync(o.id));
    yield* Effect.sleep("50 millis");
    yield* Deferred.succeed(gate, undefined);
    assert.deepStrictEqual(
      (yield* Fiber.join(all)).map((r) => r.accountId),
      ["gmail:me@gmail.com"],
    );
    const own = yield* Fiber.join(one);
    assert.deepStrictEqual(
      own.map((r) => r.accountId),
      [o.id],
    );
    assert.isAbove(own[0]?.changed ?? 0, 0, "the new account's mail was pulled");
    assert.isNotNull((yield* store.getAccount(o.id)).lastSyncedAt);
  }).pipe(
    Effect.provide(
      TestMailbox.withAdapter(
        (base) => ({
          ...base,
          pull: (account, ...args) =>
            account.provider === "gmail" && state.gated
              ? Stream.unwrap(
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as(base.pull(account, ...args)),
                  ),
                )
              : base.pull(account, ...args),
        }),
        { servers: { gmail, outlook } },
      ),
    ),
  );
});
