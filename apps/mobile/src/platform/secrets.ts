import { ProviderError, Secrets } from "@openmail/core/portable";
import { Effect, Layer, Option } from "effect";
import * as SecureStore from "expo-secure-store";

// SecureStore disallows ':' and '@'. Hex encoding is collision-free and keeps keys private to openmail.
export const secretKey = (key: string) =>
  `openmail.${Array.from(new TextEncoder().encode(key), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
const options = {
  keychainService: "openmail.refresh-tokens",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
export const secretsLayer = Layer.succeed(Secrets, {
  get: (key) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(secretKey(key), options),
      catch: () =>
        new ProviderError({
          message: "Secure storage is unavailable; unlock the device and try again",
        }),
    }).pipe(Effect.map(Option.fromNullishOr)),
  set: (key, value) =>
    Effect.tryPromise(() => SecureStore.setItemAsync(secretKey(key), value, options)).pipe(
      Effect.orDie,
    ),
  remove: (key) =>
    Effect.tryPromise(() => SecureStore.deleteItemAsync(secretKey(key), options)).pipe(
      Effect.orDie,
    ),
});
