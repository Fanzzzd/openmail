import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "vitest";
import { watchOnline } from "./online";

it("main process resumes once per reconnect and stays quiet while offline", async () => {
  let online = true;
  let reconnects = 0;
  await Effect.gen(function* () {
    yield* watchOnline(
      () => online,
      Effect.sync(() => {
        reconnects++;
      }),
    );
    online = false;
    yield* TestClock.adjust("1 minute");
    expect(reconnects).toBe(0);
    online = true;
    yield* TestClock.adjust("5 seconds");
    expect(reconnects).toBe(1);
    yield* TestClock.adjust("1 minute");
    expect(reconnects).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
});
