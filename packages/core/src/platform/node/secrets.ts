import { AsyncEntry } from "@napi-rs/keyring";
import { Effect, Layer, Option, Schedule } from "effect";

import { keychainLocked } from "../../reauth.js";
import { Secrets } from "../../services.js";

// Refresh tokens and IMAP passwords live in the OS keychain. Error handling: docs/sync-correctness.md#重新登录的判定.
const SERVICE = "openmail";
export { MODEL_KEY } from "../../secrets.js";

/** The person cancelled or denied the keychain prompt (errSecUserCanceled, -128): asking again only repeats it. */
const userCanceled = (error: unknown) =>
  error instanceof Error && /-128\b|errSecUserCanceled|user canceled/i.test(error.message);

/** Three more tries over about two seconds before the caller sees "keychain is locked". */
const KEYCHAIN_RETRY = {
  schedule: Schedule.exponential("250 millis"),
  times: 3,
  while: (error: unknown) => !userCanceled(error),
};

/** Runs a keyring call with the retry above; every final failure is a retryable keychain error. */
const keychain = <A>(call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (error) => error }).pipe(
    Effect.retry(KEYCHAIN_RETRY),
    Effect.mapError(keychainLocked),
  );

export const makeSecretsKeyring = (
  beforeRead: Effect.Effect<void> = Effect.void,
): Layer.Layer<Secrets> =>
  Layer.succeed(
    Secrets,
    Secrets.of({
      get: Effect.fn("Secrets.get")((key: string) =>
        beforeRead.pipe(
          Effect.andThen(keychain((signal) => new AsyncEntry(SERVICE, key).getPassword(signal))),
          Effect.map(Option.fromNullishOr),
          // Layer acquisition masks interruption; a native permission prompt must remain cancellable.
          Effect.interruptible,
        ),
      ),
      set: Effect.fn("Secrets.set")((key: string, value: string) =>
        keychain((signal) => new AsyncEntry(SERVICE, key).setPassword(value, signal)),
      ),
      remove: Effect.fn("Secrets.remove")((key: string) =>
        Effect.asVoid(
          Effect.promise((signal) => new AsyncEntry(SERVICE, key).deletePassword(signal)),
        ),
      ),
    }),
  );
