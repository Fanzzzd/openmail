import { expect, it } from "vitest";
import type { Draft } from "./draft";
import {
  clearDraftBackup,
  draftFromBackup,
  markRestored,
  readDraftBackup,
  wasRestored,
  writeDraftBackup,
} from "./draft-backup";

/** sessionStorage with an optional quota in characters. */
function memoryStorage(quota = Infinity) {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > quota) throw new DOMException("full", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

const draft = (patch: Partial<Draft> = {}): Draft => ({
  id: "draft:1",
  mode: "reply",
  accountId: "a1",
  to: "ana@example.com",
  cc: "",
  bcc: "",
  subject: "Re: plans",
  body: {
    kind: "rich",
    text: "long reply typed on the phone",
    html: "<p>long reply typed on the phone</p>",
  },
  attachments: [{ filename: "a.pdf", mimeType: "application/pdf", content: "QUJD" }],
  forwardAsAttachment: false,
  ...patch,
});

it("keeps the open draft across a reload of the tab", () => {
  const storage = memoryStorage();
  writeDraftBackup(draft(), true, storage, 1000);
  expect(readDraftBackup(storage, 2000)).toEqual({
    draft: draft(),
    saved: true,
    attachmentsOmitted: false,
    at: 1000,
  });
});

it("keeps the typing when attachments don't fit, and takes them from the Mac", () => {
  const storage = memoryStorage(400);
  const big = draft({
    attachments: [{ filename: "a.pdf", mimeType: "application/pdf", content: "x".repeat(1000) }],
  });
  writeDraftBackup(big, true, storage, 1000);
  const backup = readDraftBackup(storage, 1000);
  expect(backup?.attachmentsOmitted).toBe(true);
  expect(backup?.draft.attachments).toEqual([]);
  if (!backup) throw new Error("no backup");
  const onMac = draft({
    body: { kind: "rich", text: "older", html: "<p>older</p>" },
    synced: true,
  });
  expect(draftFromBackup(backup, { ...onMac, attachments: big.attachments })).toMatchObject({
    body: big.body,
    attachments: big.attachments,
    synced: true,
  });
});

it("takes the typing from the backup and the sync state from the Mac", () => {
  const storage = memoryStorage();
  writeDraftBackup(draft(), true, storage, 1000);
  const backup = readDraftBackup(storage, 1000);
  if (!backup) throw new Error("no backup");
  const onMac = draft({ subject: "older", synced: false, syncError: "offline", localOnly: true });
  expect(draftFromBackup(backup, onMac)).toEqual({
    ...draft(),
    synced: false,
    syncError: "offline",
    localOnly: true,
  });
});

it("doesn't bring back a draft the Mac had and no longer has", () => {
  const storage = memoryStorage();
  writeDraftBackup(draft(), true, storage, 1000);
  const sent = readDraftBackup(storage, 1000);
  if (!sent) throw new Error("no backup");
  // Saved once, gone now: sent or discarded.
  expect(draftFromBackup(sent, null)).toBeNull();
  // Never reached the Mac: the backup is the only copy.
  writeDraftBackup(draft(), false, storage, 1000);
  const unsaved = readDraftBackup(storage, 1000);
  if (!unsaved) throw new Error("no backup");
  expect(draftFromBackup(unsaved, null)).toEqual(draft());
});

it("clears only its own draft's backup, and forgets stale or broken ones", () => {
  const storage = memoryStorage();
  const now = Date.now();
  writeDraftBackup(draft(), false, storage, now);
  markRestored("draft:1");
  clearDraftBackup("draft:2", storage);
  expect(readDraftBackup(storage, now)).not.toBeNull();
  clearDraftBackup("draft:1", storage);
  expect(readDraftBackup(storage, now)).toBeNull();
  expect(wasRestored("draft:1")).toBe(false);

  writeDraftBackup(draft(), false, storage, 1000);
  expect(readDraftBackup(storage, 1000 + 25 * 60 * 60 * 1000)).toBeNull();
  expect(storage.items.size).toBe(0);
  storage.setItem("openmail.open-draft", "{not json");
  expect(readDraftBackup(storage)).toBeNull();
  storage.setItem("openmail.open-draft", '{"draft":{}}');
  expect(readDraftBackup(storage)).toBeNull();
  expect(readDraftBackup(null)).toBeNull();
});
