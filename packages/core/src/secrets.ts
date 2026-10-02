import { AsyncEntry } from "@napi-rs/keyring";
import { Effect, Layer, Option } from "effect";

import { Secrets } from "./services.js";

// Refresh tokens and IMAP passwords live in the OS keychain, never in the
// database or config.json. @napi-rs/keyring is N-API, so one prebuilt binary
// loads in Node and Electron. A locked or broken keychain is a defect: no
// caller can do anything about it but report it.
const SERVICE = "openmail";
export const MODEL_KEY = "anthropic-api-key";

export const SecretsKeyring: Layer.Layer<Secrets> = Layer.succeed(
  Secrets,
  Secrets.of({
    get: Effect.fn("Secrets.get")((key: string) =>
      Effect.promise((signal) => new AsyncEntry(SERVICE, key).getPassword(signal)).pipe(
        Effect.map(Option.fromNullishOr),
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
