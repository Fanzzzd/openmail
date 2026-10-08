import type { MailOp, Prefs, Provider, MailboxView } from "@openmail/core/schema";
import type { KeyEvent } from "../../shared/shortcuts";

export function usesDeletePreference(event: KeyEvent): boolean {
  return (event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey;
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
        context.provider === "gmail"
          ? { kind: "label", labelId: context.currentLabel, value: false }
          : { kind: "archive" },
      fallback: false,
    };
  return { op: { kind: "trash" }, fallback: true };
}
