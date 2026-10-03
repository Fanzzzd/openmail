import { beforeEach, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import { Secrets } from "@openmail/core/portable";
const vault = vi.hoisted(() => ({
  items: new Map<string, { value: string; accessibility: string }>(),
  state: "active",
  os: "ios",
  unlocked: true,
  corruptBackupRead: false,
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return vault.state;
    },
  },
  Platform: {
    get OS() {
      return vault.os;
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "after-first-unlock",
  getItemAsync: async (key: string) => {
    const item = vault.items.get(key);
    if (!vault.unlocked && item?.accessibility === "when-unlocked")
      throw new Error("locked private-value");
    if (item && key.endsWith(".accessibility-backup") && vault.corruptBackupRead) return "corrupt";
    return item?.value ?? null;
  },
  // SecItemUpdate preserves the old accessibility; only an absent item uses new options.
  setItemAsync: async (key: string, value: string, options: { keychainAccessible: string }) => {
    vault.set(key, value);
    vault.items.set(key, {
      value,
      accessibility: vault.items.get(key)?.accessibility ?? options.keychainAccessible,
    });
  },
  deleteItemAsync: async (key: string) => {
    vault.remove(key);
    vault.items.delete(key);
  },
}));
import {
  secretKey,
  secretBackupKey,
  secretMigrationKey,
  migrateForegroundSecrets,
  secretsLayer,
} from "./secrets";
const account = "gmail:existing@example.test";
const get = () =>
  Effect.runPromise(
    Effect.flatMap(Secrets, (secrets) => secrets.get(account)).pipe(Effect.provide(secretsLayer)),
  );
beforeEach(() => {
  vault.items.clear();
  vault.state = "active";
  vault.os = "ios";
  vault.unlocked = true;
  vault.corruptBackupRead = false;
  vault.set.mockReset();
  vault.remove.mockReset();
  vault.items.set(secretKey(account), { value: "private-value", accessibility: "when-unlocked" });
});
it("recreates existing items once while foreground and unlocked and records completion", async () => {
  await migrateForegroundSecrets([account]);
  expect(vault.items.get(secretKey(account))).toEqual({
    value: "private-value",
    accessibility: "after-first-unlock",
  });
  expect(vault.items.get(secretMigrationKey(account))?.value).toBe("done");
  expect(vault.items.has(secretBackupKey(account))).toBe(false);
  vault.remove.mockClear();
  vault.set.mockClear();
  await migrateForegroundSecrets([account]);
  expect(vault.set).not.toHaveBeenCalled();
  expect(vault.remove).not.toHaveBeenCalledWith(secretKey(account));
  vault.unlocked = false;
  expect(Option.getOrNull(await get())).toBe("private-value");
});
it("never deletes originals when locked or backup creation fails, and retries after unlock", async () => {
  vault.unlocked = false;
  await migrateForegroundSecrets([account]);
  expect(vault.remove).not.toHaveBeenCalled();
  vault.unlocked = true;
  vault.set.mockImplementationOnce(() => {
    throw new Error("backup write failed");
  });
  await migrateForegroundSecrets([account]);
  expect(vault.items.get(secretKey(account))?.value).toBe("private-value");
  expect(vault.remove).not.toHaveBeenCalled();
  await migrateForegroundSecrets([account]);
  expect(vault.items.get(secretKey(account))?.accessibility).toBe("after-first-unlock");
});
it("recovers from failure after deleting the old item through a durable verified backup", async () => {
  vault.set.mockImplementation((key: string) => {
    if (key === secretKey(account)) throw new Error("recreate failed");
  });
  await migrateForegroundSecrets([account]);
  expect(vault.items.has(secretKey(account))).toBe(false);
  expect(vault.items.get(secretBackupKey(account))?.value).toBe("private-value");
  expect(vault.items.has(secretMigrationKey(account))).toBe(false);
  vault.state = "background";
  vault.unlocked = false;
  expect(Option.getOrNull(await get())).toBe("private-value");
  vault.state = "active";
  vault.unlocked = true;
  vault.corruptBackupRead = false;
  vault.set.mockReset();
  await migrateForegroundSecrets([account]);
  expect(vault.items.get(secretKey(account))?.accessibility).toBe("after-first-unlock");
  expect(vault.items.has(secretBackupKey(account))).toBe(false);
});
it("does not migrate headless or Android, and serializes token rotation with migration", async () => {
  vault.state = "background";
  await migrateForegroundSecrets([account]);
  expect(vault.remove).not.toHaveBeenCalled();
  vault.state = "active";
  vault.os = "android";
  await migrateForegroundSecrets([account]);
  expect(vault.remove).not.toHaveBeenCalled();
  vault.os = "ios";
  await Promise.all([
    migrateForegroundSecrets([account]),
    Effect.runPromise(
      Effect.flatMap(Secrets, (secrets) => secrets.set(account, "rotated-value")).pipe(
        Effect.provide(secretsLayer),
      ),
    ),
  ]);
  expect(Option.getOrNull(await get())).toBe("rotated-value");
  expect(vault.items.get(secretKey(account))?.accessibility).toBe("after-first-unlock");
});

it("verifies the safe copy before deleting the original and handles completion-marker failure", async () => {
  vault.corruptBackupRead = true;
  await migrateForegroundSecrets([account]);
  expect(vault.remove).not.toHaveBeenCalledWith(secretKey(account));
  expect(vault.items.get(secretKey(account))?.value).toBe("private-value");
  vault.corruptBackupRead = false;
  vault.set.mockImplementation((key: string) => {
    if (key === secretMigrationKey(account)) throw new Error("marker failed");
  });
  await migrateForegroundSecrets([account]);
  expect(vault.items.get(secretBackupKey(account))?.value).toBe("private-value");
  expect(vault.items.has(secretMigrationKey(account))).toBe(false);
  vault.set.mockReset();
  await migrateForegroundSecrets([account]);
  expect(vault.items.get(secretMigrationKey(account))?.value).toBe("done");
  expect(vault.items.has(secretBackupKey(account))).toBe(false);
});

it("does not discard a newer backup after a failed update with an older completion marker", async () => {
  vault.items.set(secretMigrationKey(account), {
    value: "done",
    accessibility: "after-first-unlock",
  });
  vault.items.set(secretBackupKey(account), {
    value: "rotated-value",
    accessibility: "after-first-unlock",
  });
  await migrateForegroundSecrets([account]);
  expect(Option.getOrNull(await get())).toBe("rotated-value");
  expect(vault.items.get(secretKey(account))?.accessibility).toBe("after-first-unlock");
  expect(vault.items.has(secretBackupKey(account))).toBe(false);
});
