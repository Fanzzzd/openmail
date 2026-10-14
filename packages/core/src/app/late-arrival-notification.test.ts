import { assert, it } from "@effect/vitest";
import { Clock, Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Mailbox } from "../mailbox/mailbox.js";
import { fakeServer, incoming, TestMailbox } from "../platform/node/testing.js";

// A message the server receives while a full sync is in flight (after the provider's
// snapshot, before the cursor is saved) is fetched by the next sync but never notifies.
it.effect("mail received during a sync still notifies on the next sync", () => {
  const server = fakeServer("me@gmail.com");
  let armed = false;
  return Effect.gen(function* () {
    yield* TestClock.setTime(1_000_000);
    const m = yield* Mailbox;
    server.messages.set("old", incoming("old", { date: 999_000 }));
    yield* m.accounts.connect({ provider: "gmail" });
    yield* m.sync.sync();
    yield* m.app.takeNotifications;
    yield* TestClock.adjust("1 minute");
    armed = true;
    yield* m.sync.sync(); // the arrival lands while this sync is running
    armed = false;
    yield* TestClock.adjust("1 minute");
    server.messages.set("control", incoming("control", { date: yield* Clock.currentTimeMillis }));
    yield* TestClock.adjust("1 minute");
    yield* m.sync.sync();
    const batches = yield* m.app.takeNotifications;
    const ids = batches.flatMap((b) => b.messages.map((x) => x.id));
    assert.ok(
      ids.some((id) => id.endsWith("/control")),
      "control",
    );
    assert.ok(
      ids.some((id) => id.endsWith("/late")),
      `notified: ${JSON.stringify(ids)}`,
    );
  }).pipe(
    Effect.provide(
      TestMailbox.withAdapter(
        (base) => ({
          ...base,
          pull: (...args) =>
            base.pull(...args).pipe(
              Stream.tap((change) =>
                change._tag === "Cursor" && armed
                  ? Effect.gen(function* () {
                      // Server receives the mail now; the client finishes its work 2s later.
                      const now = yield* Clock.currentTimeMillis;
                      server.messages.set("late", incoming("late", { date: now }));
                      yield* TestClock.adjust("2 seconds");
                    })
                  : Effect.void,
              ),
            ),
        }),
        { servers: { gmail: server } },
      ),
    ),
  );
});
