import { ProviderError, Secrets, MODEL_KEY } from "@openmail/core/portable";
import { Effect, Layer, Option } from "effect";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

// SecureStore disallows ':' and '@'. Hex encoding is collision-free and keeps keys private to openmail.
export const secretKey = (key: string) =>
  `openmail.${Array.from(new TextEncoder().encode(key), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
const options = {
  keychainService: "openmail.refresh-tokens",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
export const secretBackupKey = (key: string) => `${secretKey(key)}.accessibility-backup`;
export const secretMigrationKey = (key: string) => `${secretKey(key)}.accessibility-v2`;
const locks = new Map<string, Promise<unknown>>();
function withSecretLock<A>(key: string, work: () => Promise<A>): Promise<A> {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.catch(() => null).then(work);
  locks.set(key, result);
  void result
    .finally(() => {
      if (locks.get(key) === result) locks.delete(key);
    })
    .catch(() => null);
  return result;
}
const read = (key: string) => SecureStore.getItemAsync(key, options);
const write = (key: string, value: string) => SecureStore.setItemAsync(key, value, options);
const remove = (key: string) => SecureStore.deleteItemAsync(key, options);
const unavailable = () =>
  new ProviderError({
    message: "Secure storage is unavailable; unlock the device and try again",
    reason: "keychain",
  });

/** Recreate existing iOS items while unlocked; SecItemUpdate changes only the value.
 * The verified backup remains authoritative through any failure or process exit. */
export async function migrateForegroundSecrets(keys: readonly string[]): Promise<void> {
  if (Platform.OS !== "ios" || AppState.currentState !== "active") return;
  for (const key of new Set([...keys, MODEL_KEY])) {
    try {
      await withSecretLock(key, async () => {
        if (AppState.currentState !== "active") return;
        const backupKey = secretBackupKey(key);
        if ((await read(secretMigrationKey(key))) === "done") {
          const backup = await read(backupKey);
          if (backup === null) return;
          if ((await read(secretKey(key))) === backup) {
            await remove(backupKey);
            return;
          }
          await remove(secretMigrationKey(key));
        }
        const value = (await read(backupKey)) ?? (await read(secretKey(key)));
        if (value === null) return;
        await write(backupKey, value);
        if ((await read(backupKey)) !== value) throw unavailable();
        await remove(secretKey(key));
        await write(secretKey(key), value);
        if ((await read(secretKey(key))) !== value) throw unavailable();
        await write(secretMigrationKey(key), "done");
        await remove(backupKey);
      });
    } catch {
      // Retry next foreground entry. Never expose native errors or secret values.
    }
  }
}
export const secretsLayer = Layer.succeed(Secrets, {
  get: (key) =>
    Effect.tryPromise({
      try: () =>
        withSecretLock(
          key,
          async () =>
            (Platform.OS === "ios" ? await read(secretBackupKey(key)) : null) ??
            (await read(secretKey(key))),
        ),
      catch: unavailable,
    }).pipe(Effect.map(Option.fromNullishOr)),
  set: (key, value) =>
    Effect.tryPromise({
      try: () =>
        withSecretLock(key, async () => {
          if (Platform.OS === "ios" && (await read(secretBackupKey(key))) !== null) {
            await remove(secretMigrationKey(key));
            await write(secretBackupKey(key), value);
          }
          await write(secretKey(key), value);
        }),
      catch: unavailable,
    }),
  remove: (key) =>
    Effect.tryPromise({
      try: () =>
        withSecretLock(key, async () => {
          await remove(secretKey(key));
          if (Platform.OS === "ios") {
            await remove(secretBackupKey(key));
            await remove(secretMigrationKey(key));
          }
        }),
      catch: unavailable,
    }),
});
