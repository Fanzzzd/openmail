import type { PerformError } from "./mailbox.js";
import { Clock, Effect } from "effect";
import { SendUncertain } from "./errors.js";

/** Only re-check delivery. The submission itself is never repeated. */
export const confirmDelivery = <E, R>(lookup: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const delays = [0, 1000, 2000, 4000, 8000, 15000];
    for (const delay of delays) {
      if (delay)
        yield* Effect.sleep(
          Math.min(delay, Math.max(0, 30000 - ((yield* Clock.currentTimeMillis) - started))),
        );
      const remaining = Math.max(1000, 30000 - ((yield* Clock.currentTimeMillis) - started));
      const found = yield* lookup.pipe(
        Effect.timeout(remaining),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (found) return;
    }
    yield* new SendUncertain({
      message: "This message may have been sent. Check Sent before sending it again.",
    });
  });

export function isDefiniteSendFailure(error: PerformError): boolean {
  // Adapters convert unconfirmed submissions to SendUncertain. Other errors
  // describe a rejected submission or preparation that failed before sending.
  return error._tag !== "SendUncertain";
}
