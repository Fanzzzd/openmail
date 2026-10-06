import { Cause, Option } from "effect";
import type { Message } from "../../shared/api";
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
