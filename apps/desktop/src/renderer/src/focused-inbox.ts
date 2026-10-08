import { Cause, Option } from "effect";
import type { Message, Provider } from "../../shared/api";
import type { ThreadState } from "./components/ThreadActions";
import type { AppError } from "./errors";

export const FOCUSED_PERMISSION_EVENT = "openmail:focused-permission";
export function requestFocusedPermission(cause: Cause.Cause<AppError>): boolean {
  const error = Cause.findErrorOption(cause);
  if (
    Option.isNone(error) ||
    error.value._tag !== "FeatureScopeMissing" ||
    error.value.feature !== "focusedInbox"
  )
    return false;
  window.dispatchEvent(
    new CustomEvent(FOCUSED_PERMISSION_EVENT, { detail: error.value.accountId }),
  );
  return true;
}

/** Project an already selected external message into the toolbar's override target. */
export const focusedSender = (message?: Pick<Message, "id" | "from">) =>
  message ? { focusedSender: { messageId: message.id, address: message.from.address } } : {};

/** What the thread toolbar and menus act on for these messages. */
export const threadStateFor = (
  provider: Provider,
  messages: readonly Message[],
  focused: Message | undefined,
): ThreadState => ({
  provider,
  ...focusedSender(focused),
  isUnread: messages.some((m) => m.isUnread),
  isStarred: messages.some((m) => m.isStarred),
  isImportant: messages.some((m) => m.labels.includes("IMPORTANT")),
  labels: [...new Set(messages.flatMap((m) => m.labels))],
});

/** Prefer the selected external message; otherwise use the newest external sender. */
export function focusedSenderMessage(
  messages: readonly Message[] | undefined,
  ownAddresses: readonly string[],
  selectedId?: string,
): Message | undefined {
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()));
  const external =
    messages?.filter(
      (message) =>
        message.from.address.trim() && !own.has(message.from.address.trim().toLowerCase()),
    ) ?? [];
  const selected = external.find((message) => message.id === selectedId);
  return (
    selected ??
    external.reduce<Message | undefined>(
      (newest, message) => (!newest || message.date >= newest.date ? message : newest),
      undefined,
    )
  );
}
