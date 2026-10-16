import { expect, it } from "vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { holdingAcceptedClaim } from "./mailbox-accepted-sends.js";
import type { Store } from "../store/service.js";

/** Only the two claim calls holdingAcceptedClaim makes; the rest of the store is never touched. */
const claimStore = (renew: () => Effect.Effect<void>) => {
  const calls = { renewed: 0, released: 0 };
  const store = {
    renewSmtpAccepted: () =>
      Effect.suspend(() => {
        calls.renewed++;
        return renew();
      }),
    releaseSmtpAccepted: () =>
      Effect.sync(() => {
        calls.released++;
      }),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double with the two methods the holder calls
  return { store: store as unknown as Store["Service"], calls };
};

const send = (done: { finished: boolean }) =>
  Effect.sleep("45 seconds").pipe(
    Effect.andThen(
      Effect.sync(() => {
        done.finished = true;
      }),
    ),
    Effect.as("delivered"),
  );

const runFor = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      yield* TestClock.adjust("60 seconds");
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

// The renewal used to race the send with raceFirst, and the store dies on SQL errors, so a
// SQLITE_BUSY in a renewal ended the race and interrupted the live send, maybe after SMTP 250.
it("a renewal that dies leaves the live send running to the end", async () => {
  const { store, calls } = claimStore(() =>
    Effect.die(new Error("SQLITE_BUSY: database is locked")),
  );
  const done = { finished: false };
  const exit = await runFor(send(done).pipe(holdingAcceptedClaim(store, "d", "t")));
  expect(Exit.isSuccess(exit) && exit.value).toBe("delivered");
  expect(done.finished).toBe(true);
  expect(calls.renewed).toBeGreaterThan(0);
  expect(calls.released).toBe(0);
});

it("a holder does not renew before its accepted record exists", async () => {
  const { store, calls } = claimStore(() => Effect.void);
  const done = { finished: false };
  const exit = await runFor(send(done).pipe(holdingAcceptedClaim(store, "d", "t", () => false)));
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(calls.renewed).toBe(0);
});
