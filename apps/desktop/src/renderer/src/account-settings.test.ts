import { expect, it, vi } from "vitest";
import type { Account } from "@openmail/core/schema";
import { accountSettingsInput, runAccountMove } from "./account-settings";
const account: Account = {
  id: "gmail:me@example.com",
  email: "me@example.com",
  provider: "gmail",
  enabled: true,
  description: "Saved name",
  color: "#123456",
  profileId: null,
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  needsReauth: false,
};
it("toggling keeps persisted appearance; unsaved edits are used only by Save", () => {
  const edits = { kind: "appearance", description: "Unsaved name", color: "#ffffff" } as const;
  expect(accountSettingsInput(account, { kind: "toggle", enabled: false })).toEqual({
    enabled: false,
    description: "Saved name",
    color: "#123456",
  });
  expect(
    accountSettingsInput({ ...account, enabled: false }, { kind: "toggle", enabled: true }),
  ).toEqual({ enabled: true, description: "Saved name", color: "#123456" });
  expect(accountSettingsInput({ ...account, enabled: false }, edits)).toEqual({
    enabled: false,
    description: "Unsaved name",
    color: "#ffffff",
  });
});
it("rapid moves stay blocked until the first request finishes, including failed requests", async () => {
  const lock = { current: false };
  let release: () => void = () => {
    throw new Error("not started");
  };
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = runAccountMove(lock, send);
  expect(lock.current).toBe(true);
  await runAccountMove(lock, send);
  expect(send).toHaveBeenCalledTimes(1);
  release();
  await pending;
  expect(lock.current).toBe(false);
  await expect(
    runAccountMove(lock, () => Promise.reject(new Error("move failed"))),
  ).rejects.toThrow("move failed");
  expect(lock.current).toBe(false);
  await runAccountMove(lock, () => Promise.resolve());
  expect(lock.current).toBe(false);
});
