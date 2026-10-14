import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";
import { Mailbox } from "./mailbox.js";

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
