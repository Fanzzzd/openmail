import { expect, it } from "vitest";
import { deleteKeyOp, usesDeletePreference } from "./delete-key";
import type { Provider } from "../../shared/api";
import type { KeyEvent } from "../../shared/shortcuts";
const key = (metaKey = false, ctrlKey = false): KeyEvent => ({
  key: "Backspace",
  metaKey,
  ctrlKey,
  shiftKey: false,
  altKey: false,
});
it("Cmd/Ctrl Backspace always trashes and never follows the Delete preference", () => {
  expect(usesDeletePreference(key())).toBe(true);
  expect(usesDeletePreference({ ...key(), key: "Delete" })).toBe(true);
  expect(usesDeletePreference(key(true))).toBe(false);
  expect(usesDeletePreference(key(false, true))).toBe(false);
});
it("removeLabel archives Inbox for every provider and folder-model custom folders", () => {
  for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
    expect(deleteKeyOp("removeLabel", { mailbox: "inbox", provider }).op).toEqual({
      kind: "archive",
    });
    expect(deleteKeyOp("removeLabel", { currentLabel: "INBOX", provider }).op).toEqual({
      kind: "archive",
    });
    expect(
      deleteKeyOp("removeLabel", { mailbox: "all", currentLabel: "Label_work", provider }).op,
    ).toEqual(
      provider === "gmail"
        ? { kind: "label", labelId: "Label_work", value: false }
        : { kind: "archive" },
    );
  }
});
it("no applicable label falls back to trash with explanation; Trash/Spam retain the normal delete path", () => {
  for (const mailbox of ["starred", "sent", "all"] as const)
    expect(deleteKeyOp("removeLabel", { mailbox })).toEqual({
      op: { kind: "trash" },
      fallback: true,
    });
  expect(deleteKeyOp("removeLabel", {})).toEqual({ op: { kind: "trash" }, fallback: true });
  for (const mailbox of ["trash", "spam"] as const)
    for (const action of ["trash", "archive", "removeLabel"] as const)
      expect(deleteKeyOp(action, { mailbox })).toEqual({ op: { kind: "trash" }, fallback: false });
});
