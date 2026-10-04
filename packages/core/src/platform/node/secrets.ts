import { AsyncEntry } from "@napi-rs/keyring";
import { Effect, Layer, Option } from "effect";

import { Secrets } from "../../services.js";

// Refresh tokens and IMAP passwords live in the OS keychain, never in the
// database or config.json. @napi-rs/keyring is N-API, so one prebuilt binary
// loads in Node and Electron. A locked or broken keychain is a defect: no
// caller can do anything about it but report it.
const SERVICE = "openmail";
export { MODEL_KEY } from "../../secrets.js";

export const makeSecretsKeyring = (
  beforeRead: Effect.Effect<void> = Effect.void,
): Layer.Layer<Secrets> =>
  Layer.succeed(
    Secrets,
    Secrets.of({
      get: Effect.fn("Secrets.get")((key: string) =>
        beforeRead.pipe(
          Effect.andThen(
            Effect.promise((signal) => new AsyncEntry(SERVICE, key).getPassword(signal)),
          ),
          Effect.map(Option.fromNullishOr),
          // Layer acquisition masks interruption; a native permission prompt must remain cancellable.
          Effect.interruptible,
        ),
      ),
      set: Effect.fn("Secrets.set")((key: string, value: string) =>
        Effect.promise((signal) => new AsyncEntry(SERVICE, key).setPassword(value, signal)),
      ),
      remove: Effect.fn("Secrets.remove")((key: string) =>
        Effect.asVoid(
          Effect.promise((signal) => new AsyncEntry(SERVICE, key).deletePassword(signal)),
        ),
      ),
    }),
  );
