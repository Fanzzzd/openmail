import { assert, it } from "@effect/vitest";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { retryProvider } from "./provider-retry.js";

it.effect("slice55: Retry-After has a sixty-second total budget across retries", () =>
  Effect.gen(function* () {
    let calls = 0;
    const started = yield* Clock.currentTimeMillis;
    const fiber = yield* retryProvider(
      Effect.suspend(() => {
        calls++;
        return Effect.fail({ retryAfter: "30" });
      }),
      () => true,
    ).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("2 minutes");
    yield* Fiber.join(fiber);
    assert.strictEqual(calls, 3);
    // Later clock adjustment also completes a broken implementation, so the call count detects it.
    assert.isAtLeast((yield* Clock.currentTimeMillis) - started, 60000);
  }),
);
