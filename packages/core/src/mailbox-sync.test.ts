import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { splitWriteBatch } from "./mailbox-sync.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import { incoming, TestMailbox } from "./platform/node/testing.js";
import { type Change } from "./services.js";

const upsert = (id: string, htmlLength: number): Change => ({
  _tag: "Upsert",
  message: incoming(id, { bodyHtml: "x".repeat(htmlLength), bodyText: "" }),
});
const tags = (parts: Change[][]) =>
  parts.map((part) =>
    part.map((change) => (change._tag === "Upsert" ? change.message.providerId : change._tag)),
  );

it("cuts a write batch by body size and keeps each message's Progress with it", () => {
  const progress: Change = { _tag: "Progress", fetched: 1, total: 4 };
  const batch = [
    upsert("a", 105_000),
    progress,
    upsert("b", 105_000),
    progress,
    upsert("c", 50_000),
    upsert("d", 20_000),
    { _tag: "Cursor", cursor: "end" } satisfies Change,
  ];
  expect(tags(splitWriteBatch(batch, 200_000))).toEqual([
    ["a", "Progress"],
    ["b", "Progress", "c", "d", "Cursor"],
  ]);
  // A message over the budget gets its own transaction; small batches stay whole.
  expect(tags(splitWriteBatch([upsert("big", 500_000), upsert("e", 10)], 200_000))).toEqual([
    ["big"],
    ["e"],
  ]);
  expect(splitWriteBatch([progress, progress], 200_000)).toEqual([[progress, progress]]);
  expect(splitWriteBatch([])).toEqual([]);
});

// IMAP renewed it already; its connect also needs server settings.
for (const provider of ["gmail", "outlook"] as const)
  it(`${provider}: a full sync renews the inbox cursor, so inbox polls never start from an expired one`, async () => {
    const server = fakeServer("me@example.com", [incoming("one")]);
    const runtime = ManagedRuntime.make(TestMailbox({ [provider]: server }));
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* m.connect({ provider });
          yield* m.sync(); // cursor "1"
          yield* m.pollInbox(); // inbox cursor "2"
          // Full syncs keep going (on a phone: in the foreground) while polls stop for a while.
          yield* m.sync(); // cursor "2"
          yield* m.sync(); // cursor "3"
          yield* m.pollInbox();
          // The poll starts from the newest full-sync cursor, not the one its last poll left.
          expect(server.pulls).toEqual([null, "1", "1", "2", "3"]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

it.effect("the snooze wake loop keeps running after one failed pass", () =>
  Effect.gen(function* () {
    let calls = 0;
    const flakyStore = Layer.effect(
      Store,
      Effect.map(Store, (store) => ({
        ...store,
        wakeSnoozed: (now: number) =>
          Effect.suspend(() => {
            calls++;
            return calls === 1
              ? Effect.die(new Error("database is locked"))
              : store.wakeSnoozed(now);
          }),
      })),
    ).pipe(Layer.provide(StoreLive));
    const live = MailboxLive({
      autoSync: "1 hour",
      backgroundReady: Effect.never,
      backgroundFlush: false,
      imapIdle: false,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          flakyStore,
          Layer.succeed(Providers, {
            get: () => makeFakeProvider(fakeServer("me@example.test")),
          }),
        ).pipe(Layer.provideMerge(MemoryPlatform())),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Mailbox;
      yield* TestClock.adjust("1 second");
      assert.strictEqual(calls, 1);
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(calls, 3);
    }).pipe(Effect.provide(live));
  }),
);
