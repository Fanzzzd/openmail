import {
  parseSearchQuery,
  replyRecipients,
  splitAddresses,
  isEmailAddress,
  type ComposeMode,
  type Message,
  type OutgoingMessage,
  type Prefs,
  type SwipeAction,
  type MailOp,
  type Mailbox,
  type Label,
  type Provider,
} from "@openmail/core/portable";

export function swipeAction(distance: number, prefs: Prefs["swipeActions"]): SwipeAction {
  if (Math.abs(distance) < 60) return "none";
  return distance < 0
    ? Math.abs(distance) >= 180
      ? prefs.leftLong
      : prefs.leftShort
    : Math.abs(distance) >= 180
      ? prefs.rightLong
      : prefs.rightShort;
}
export function toggleSelection(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}
export function swipeOperation(
  action: Exclude<SwipeAction, "none" | "snooze">,
  row: Pick<Message, "isUnread" | "isStarred">,
): MailOp {
  if (action === "read") return { kind: "read", value: row.isUnread };
  if (action === "star") return { kind: "star", value: !row.isStarred };
  return { kind: action };
}
export function composeMessage(
  mode: ComposeMode,
  original?: Message,
  own: readonly string[] = [],
): OutgoingMessage {
  const recipients =
    original && (mode === "reply" || mode === "replyAll")
      ? replyRecipients(original, own, mode === "replyAll")
      : { to: [], cc: [] };
  return {
    ...recipients,
    bcc: [],
    attachments: [],
    mode,
    subject: original
      ? `${mode === "forward" ? "Fwd: " : /^re:/i.test(original.subject) ? "" : "Re: "}${original.subject}`
      : "",
    text: original
      ? `\n\n${original.bodyText
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`
      : "",
    ...(original ? { inReplyTo: original.id } : {}),
  };
}
export function draftRecipients(value: string) {
  return splitAddresses(value)
    .filter((part) => part.trim())
    .map((part) => {
      const match = /^(.*?)<([^<>]+)>$/.exec(part.trim());
      return {
        name: match?.[1]?.trim().replace(/^"|"$/g, "") ?? "",
        address: (match?.[2] ?? part).trim(),
      };
    });
}
export function parseRecipients(value: string) {
  const addresses = draftRecipients(value);
  if (addresses.some((address) => !isEmailAddress(address.address)))
    throw new Error("Invalid recipient");
  return addresses;
}
export type Format = "plain" | "bold" | "italic" | "list";
export const searchQuery = (accountId: string, search: string) =>
  parseSearchQuery({ accountIds: [accountId], search, limit: 100 });
export const modifyThreads = (mailbox: Mailbox["Service"], ids: readonly string[], op: MailOp) =>
  mailbox.modifyWithUndo(ids, op);
export const applyLabel = (
  mailbox: Mailbox["Service"],
  ids: readonly string[],
  provider: string,
  labelId: string,
  removeLabelId: string | null,
) =>
  modifyThreads(
    mailbox,
    ids,
    provider === "gmail"
      ? { kind: "label", labelId, value: true }
      : { kind: "move", labelId, removeLabelId },
  );

/** Serial autosaves cannot finish in reverse order; send waits for the last edit. */
export function draftWriter(save: (message: OutgoingMessage) => Promise<unknown>) {
  let pending = Promise.resolve();
  return {
    save(message: OutgoingMessage) {
      const next = pending
        .catch(() => null)
        .then(() => save(message))
        .then(() => {
          return;
        });
      pending = next;
      return next;
    },
    flush: () => pending,
  };
}
/** One foreground sync at a time; checks connectivity again before delivery. */
export function foregroundCoordinator(deps: {
  active: () => boolean;
  online: () => Promise<boolean>;
  sync: () => Promise<unknown>;
  prepare?: () => Promise<void>;
  send: () => Promise<unknown>;
  badge?: () => Promise<unknown>;
}) {
  let pending: Promise<void> | null = null;
  let sendRequested = false;
  const needsAnotherSend = () => sendRequested;
  return (sync: boolean) => {
    if (pending) {
      if (!sync) sendRequested = true;
      return pending;
    }
    pending = (async () => {
      if (!deps.active()) return;
      if (sync && deps.prepare) await deps.prepare();
      if (!deps.active() || !(await deps.online())) return;
      if (sync) await deps.sync();
      do {
        sendRequested = false;
        if (deps.active() && (await deps.online())) await deps.send();
        if (deps.active()) await deps.badge?.();
      } while (needsAnotherSend() && deps.active());
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
export const unreadBadge = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

export const labelDestinations = (provider: Provider, labels: readonly Label[]) =>
  labels.filter((label) =>
    provider === "gmail"
      ? label.id.startsWith("Label_")
      : !label.id.startsWith("category:") && !["DRAFT", "SENT"].includes(label.id),
  );

/** Initialization never persists a draft. Only edits enable autosave; discard waits
 * for outstanding writes before deleting through core, so they cannot recreate it. */
export function draftSession(
  save: (message: OutgoingMessage) => Promise<unknown>,
  discard: () => Promise<unknown>,
) {
  const writer = draftWriter(save);
  let dirty = false;
  let enabled = true;
  return {
    markEdited: () => {
      dirty = true;
    },
    pause: () => {
      enabled = false;
    },
    resume: () => {
      enabled = true;
    },
    save: (message: OutgoingMessage) => writer.save(message),
    flush: writer.flush,
    autosave: async (message: OutgoingMessage) => {
      if (!dirty || !enabled) return false;
      await writer.save(message);
      return true;
    },
    discard: async () => {
      enabled = false;
      await writer.flush().catch(() => null);
      await discard();
    },
  };
}
