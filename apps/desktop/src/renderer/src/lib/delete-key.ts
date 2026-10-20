import {
  providerCapabilities,
  type MailOp,
  type Prefs,
  type Provider,
  type MailboxView,
} from "@openmail/core/schema";
import type { KeyEvent } from "../../../shared/shortcuts";

export function usesDeletePreference(event: KeyEvent): boolean {
  return (event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey;
}
/**
 * Forward Delete (Fn-Delete on a Mac keyboard) in a field with a highlighted suggestion removes
 * that suggestion, as Chrome removes an autofill entry. Shift-Delete always does. Plain Delete
 * does only at the end of the text, where it would delete nothing; before that it edits the
 * text. Backspace, with or without Shift, always edits the text.
 */
export function removesSuggestion(
  event: KeyEvent,
  input: { value: string; selectionStart: number | null; selectionEnd: number | null },
): boolean {
  if (event.key !== "Delete" || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.shiftKey) return true;
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}
interface DeleteContext {
  mailbox?: MailboxView;
  currentLabel?: string;
  provider?: Provider;
}
export function deleteKeyOp(
  action: Exclude<Prefs["deleteKeyAction"], "ask">,
  context: DeleteContext,
): { op: MailOp; fallback: boolean } {
  if (context.mailbox === "trash" || context.mailbox === "spam")
    return { op: { kind: "trash" }, fallback: false };
  if (action !== "removeLabel") return { op: { kind: action }, fallback: false };
  if (context.mailbox === "inbox" || context.currentLabel === "INBOX")
    return { op: { kind: "archive" }, fallback: false };
  if (context.currentLabel)
    return {
      op:
        context.provider && providerCapabilities(context.provider).organization === "labels"
          ? { kind: "label", labelId: context.currentLabel, value: false }
          : { kind: "archive" },
      fallback: false,
    };
  return { op: { kind: "trash" }, fallback: true };
}
