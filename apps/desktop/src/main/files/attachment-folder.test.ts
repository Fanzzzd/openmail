import { Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_PREFS, type Prefs } from "@openmail/core/schema";
import type { OpenDialogOptions } from "electron";
import { rendererPrefs } from "../../shared/renderer-prefs";
import { chooseAttachmentFolder } from "./attachment-folder";

it("SetPrefs from the renderer rejects a custom save folder but allows resets and other fields", () => {
  const rejected = Effect.runSyncExit(
    rendererPrefs({
      attachmentSaveFolder: { kind: "custom", path: "/Users/me/Library/LaunchAgents" },
    }),
  );
  expect(Exit.isFailure(rejected)).toBe(true);
  expect(JSON.stringify(rejected)).toContain("InvalidInput");
  for (const patch of [
    { attachmentSaveFolder: { kind: "ask" as const } },
    { attachmentSaveFolder: { kind: "downloads" as const } },
    { spellcheck: false },
  ])
    expect(Effect.runSync(rendererPrefs(patch))).toEqual(patch);
});

const fakeMailbox = (current: Prefs["attachmentSaveFolder"]) => {
  const stored: Partial<Prefs>[] = [];
  return {
    stored,
    mailbox: {
      prefs: Effect.succeed({
        ...DEFAULT_PREFS,
        ...(current ? { attachmentSaveFolder: current } : {}),
      }),
      setPrefs: (patch: Partial<Prefs>) =>
        Effect.sync(() => {
          stored.push(patch);
        }),
    },
  };
};

it("stores the folder chosen in the main-process picker, starting from the current folder", async () => {
  const { mailbox, stored } = fakeMailbox({ kind: "custom", path: "/Users/me/Mail" });
  const show = vi.fn(async () => ({ canceled: false, filePaths: ["/Users/me/Saved"] }));
  expect(await Effect.runPromise(chooseAttachmentFolder(mailbox, show))).toBe("/Users/me/Saved");
  expect(show).toHaveBeenCalledWith({
    defaultPath: "/Users/me/Mail",
    properties: ["openDirectory", "createDirectory"],
  });
  expect(stored).toEqual([{ attachmentSaveFolder: { kind: "custom", path: "/Users/me/Saved" } }]);
});

it("a cancelled picker keeps the stored folder", async () => {
  const { mailbox, stored } = fakeMailbox({ kind: "ask" });
  const show = vi.fn(async (_options: OpenDialogOptions) => ({ canceled: true, filePaths: [] }));
  expect(await Effect.runPromise(chooseAttachmentFolder(mailbox, show))).toBeNull();
  expect(show.mock.calls[0]?.[0]).not.toHaveProperty("defaultPath");
  expect(stored).toEqual([]);
});
