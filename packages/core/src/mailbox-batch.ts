import { PlatformCrypto } from "./platform/crypto.js";
import { categoryKey } from "./domain/categories.js";
import { invalidCategoryFolderOp } from "./domain/mail-ops.js";
import { Clock, Effect, Option, Semaphore } from "effect";

import {
  UNDO_HISTORY_TTL_MS,
  isOutlookClassification,
  type Actor,
  type MailOp,
  type Message,
  type Provider,
  type IncomingMessage,
} from "./domain/domain.js";
import { messagesFrom } from "./reading.js";
import { requireFocusedInboxScope } from "./optional-services.js";
import { InvalidInput } from "./domain/errors.js";
import type { Mailbox } from "./mailbox.js";
import type { ReminderSnapshot, Store } from "./services.js";
import { undoStateKey, type UndoState } from "./undo-journal.js";
import { applyOpToLabels, folderTarget } from "./store.js";

const user: Actor = { kind: "user", surface: "app" };
interface Change {
  id: string;
  op: MailOp;
}
interface UndoBatch {
  messageIds: readonly string[];
  changes: readonly Change[];
  reminders: ReminderSnapshot[];
  localChanges?: readonly Change[];
}

/** Restore only the fields this op changed, using each message's actual state. */
function inverse(message: Message, provider: Provider, op: MailOp): MailOp[] {
  if (op.kind === "read") return [{ kind: "read", value: !message.isUnread }];
  if (op.kind === "important" && provider !== "imap")
    return [{ kind: "important", value: message.labels.includes("IMPORTANT") }];
  if (op.kind === "star") return [{ kind: "star", value: message.isStarred }];
  if (op.kind === "classification")
    return [
      {
        kind: "classification",
        // Unknown cached classification has the same effective behavior as Focused.
        value: message.labels.includes("CATEGORY_OTHER") ? "other" : "focused",
      },
    ];
  if (op.kind === "categories") {
    const current = message.labels
      .filter((label) => label.startsWith("category:"))
      .map((label) => label.slice(9));
    return [
      {
        kind: "categories",
        add: current.filter((name) =>
          op.remove.some((removed) => categoryKey(removed) === categoryKey(name)),
        ),
        remove: op.add.filter(
          (name) => !current.some((old) => categoryKey(old) === categoryKey(name)),
        ),
      },
    ];
  }
  if (op.kind === "copy") return [];
  if (provider !== "gmail") {
    if (!folderTarget(op, message.labels)) return [];
    const folder = message.labels.find(
      (l) =>
        !["UNREAD", "STARRED", "IMPORTANT", "SNOOZED"].includes(l) &&
        !l.startsWith("category:") &&
        !(provider === "outlook" && isOutlookClassification(l)),
    );
    switch (folder) {
      case "INBOX":
        return [{ kind: "inbox" }];
      case "ARCHIVE":
        return [{ kind: "archive" }];
      case "TRASH":
        return [{ kind: "trash" }];
      case "SPAM":
        return [{ kind: "spam" }];
      case undefined:
        return [];
      default:
        return [{ kind: "label", labelId: folder, value: true }];
    }
  }
  let after = applyOpToLabels(message.labels, op, provider);
  const restores: MailOp[] = [];
  // Gmail requires trash/untrash endpoints. Inbox performs untrash; label
  // differences below then remove the temporary Inbox label when needed.
  if (after.includes("TRASH") && !message.labels.includes("TRASH")) {
    restores.push({ kind: "inbox" });
    after = applyOpToLabels(after, { kind: "inbox" }, provider);
  } else if (!after.includes("TRASH") && message.labels.includes("TRASH")) {
    restores.push({ kind: "trash" });
    after = applyOpToLabels(after, { kind: "trash" }, provider);
  }
  const before = new Set(message.labels);
  const later = new Set(after);
  const labels: MailOp[] = [...new Set([...message.labels, ...after])]
    .filter((label) => label !== "SNOOZED" && before.has(label) !== later.has(label))
    .map((labelId) => ({ kind: "label", labelId, value: before.has(labelId) }));
  return [...restores, ...labels];
}

const applyChanges = (store: Store["Service"], changes: readonly Change[]) =>
  Effect.gen(function* () {
    // Sync may remove some of the captured IDs before apply/undo.
    const resolved = yield* Effect.forEach(changes, (change) =>
      store.messageRef(change.id).pipe(
        Effect.option,
        Effect.map((ref) => (Option.isSome(ref) ? [{ ...change, ...ref.value }] : [])),
      ),
    );
    for (const change of resolved.flat()) {
      yield* store.applyLocalOp(change.id, change.op);
      if (change.op.kind === "copy") {
        // Each destination owns a queue entry: a later failure must not repeat earlier copies.
        for (const labelId of new Set(change.op.labelIds))
          yield* store.enqueueOp(change.accountId, change.providerId, {
            kind: "copy",
            labelIds: [labelId],
          });
      } else yield* store.enqueueOp(change.accountId, change.providerId, change.op);
      yield* store.appendAudit({
        actor: user,
        accountId: change.accountId,
        action: change.op.kind,
        detail: { id: change.id, op: change.op },
      });
    }
  });

/** Durable organizational history; reminder restoration remains process-local. */
export const makeBatchMailbox = (
  store: Store["Service"],
  changed: Effect.Effect<void>,
  flushLater: Effect.Effect<void>,
  verify?: (id: string) => Effect.Effect<IncomingMessage, import("./mailbox.js").PerformError>,
  verifyFolder?: (
    accountId: string,
    labelId: string,
  ) => Effect.Effect<void, import("./mailbox.js").PerformError>,
) =>
  Effect.gen(function* () {
    const crypto = yield* PlatformCrypto;
    const lock = yield* Semaphore.make(1);
    const history = new Map<string, UndoBatch>();
    const modifyWithUndo: Mailbox["Service"]["modifyWithUndo"] = (threads, op, flat = false) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (!threads.length)
              return yield* new InvalidInput({ message: "Select at least one conversation." });
            if (invalidCategoryFolderOp(op))
              return yield* new InvalidInput({
                message: "Categories cannot be used as folders. Use the categories action.",
              });
            const undoId = crypto.randomUUID();
            const back = yield* store.transaction(
              Effect.gen(function* () {
                const ids = new Set<string>();
                for (const thread of threads) {
                  const message = flat
                    ? yield* store.getMessage(thread).pipe(Effect.option)
                    : Option.none();
                  const found = flat
                    ? Option.isSome(message)
                      ? [message.value.id]
                      : []
                    : yield* store.threadMessageIds(thread);
                  for (const id of found) {
                    if (
                      op.kind === "classification" &&
                      !(yield* store.getMessage(id)).labels.includes("INBOX")
                    )
                      continue;
                    ids.add(id);
                  }
                }
                const forward: Change[] = [];
                const inverses: Change[] = [];
                const reminders = new Map<string, ReminderSnapshot>();
                for (const id of ids) {
                  const message = yield* store.getMessage(id);
                  const account = yield* store.getAccount(message.accountId);
                  if (
                    ((op.kind === "categories" || op.kind === "classification") &&
                      account.provider !== "outlook") ||
                    (op.kind === "copy" && account.provider !== "imap")
                  )
                    return yield* new InvalidInput({
                      message: "This organization action is unavailable for this account.",
                    });
                  if (op.kind === "classification")
                    yield* requireFocusedInboxScope(store, account.id);
                  if (
                    op.kind === "categories" &&
                    [...op.add, ...op.remove].some((name) => !name.trim() || /[\r\n\0]/.test(name))
                  )
                    return yield* new InvalidInput({ message: "Enter valid category names." });
                  if (
                    op.kind === "copy" &&
                    !op.labelIds.every((labelId) => labelId && !labelId.startsWith("category:"))
                  )
                    return yield* new InvalidInput({
                      message: "Choose folders from this account.",
                    });
                  if (op.kind === "copy") {
                    const folders = yield* store.listLabels([account.id]);
                    if (
                      !op.labelIds.every((labelId) =>
                        folders.some((folder) => folder.id === labelId),
                      )
                    )
                      return yield* new InvalidInput({
                        message: "Choose folders from this account.",
                      });
                  }
                  if (
                    op.kind === "move" &&
                    !(yield* store.listLabels([account.id])).some((l) => l.id === op.labelId) &&
                    !["INBOX", "ARCHIVE", "TRASH", "SPAM"].includes(op.labelId)
                  )
                    return yield* new InvalidInput({
                      message: "Choose a destination from this account",
                    });
                  if (
                    account.provider !== "gmail" &&
                    op.kind !== "read" &&
                    op.kind !== "star" &&
                    !(op.kind === "important" && account.provider === "outlook") &&
                    op.kind !== "categories" &&
                    op.kind !== "classification" &&
                    op.kind !== "copy" &&
                    !folderTarget(op, message.labels)
                  )
                    continue;
                  forward.push({ id, op });
                  if (
                    op.kind === "read" ||
                    op.kind === "archive" ||
                    op.kind === "inbox" ||
                    op.kind === "trash" ||
                    op.kind === "spam" ||
                    op.kind === "move" ||
                    (op.kind === "label" && op.value && account.provider !== "gmail")
                  ) {
                    const reminder = yield* store.reminderSnapshot(id);
                    if (Option.isSome(reminder))
                      reminders.set(
                        JSON.stringify([message.accountId, message.threadId]),
                        reminder.value,
                      );
                  }
                  inverses.push(
                    ...inverse(message, account.provider, op).map((inverseOp) => ({
                      id,
                      op: inverseOp,
                    })),
                  );
                }
                yield* applyChanges(store, forward);
                const expected = yield* Effect.forEach([...ids], (id) =>
                  store.getMessage(id).pipe(
                    Effect.map((m) => ({
                      id,
                      accountId: m.accountId,
                      labels: m.labels,
                      isUnread: m.isUnread,
                      isStarred: m.isStarred,
                    })),
                  ),
                );
                if (op.kind !== "copy")
                  yield* store.saveUndoJournal(undoId, {
                    changes: inverses,
                    expected,
                    localExpected: expected,
                  });
                return {
                  messageIds: [...ids],
                  changes: inverses,
                  reminders: [...reminders.values()],
                };
              }),
            );
            if (op.kind !== "copy") history.set(undoId, back);
            if (history.size > 50) {
              const oldest = history.keys().next().value;
              if (oldest) history.delete(oldest);
            }
            return { undoId: op.kind === "copy" ? "" : undoId };
          }),
        )
        .pipe(
          Effect.tap(() => changed),
          Effect.tap(() => flushLater),
        );
    const snoozeWithUndo: Mailbox["Service"]["snoozeWithUndo"] = (threads, due) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (!Number.isFinite(due) || due <= now)
              return yield* new InvalidInput({ message: "Choose a future reminder time" });
            if (!threads.length)
              return yield* new InvalidInput({ message: "Choose a conversation" });
            const undoId = crypto.randomUUID();
            const back = yield* store.transaction(
              Effect.gen(function* () {
                const localChanges: Change[] = [];
                const messageIds = new Set<string>();
                const reminders: ReminderSnapshot[] = [];
                const seen = new Set<string>();
                const expected: (typeof UndoState.Type)[] = [];
                for (const id of threads) {
                  const message = yield* store.getMessage(id);
                  const threadKey = JSON.stringify([message.accountId, message.threadId]);
                  if (seen.has(threadKey)) continue;
                  seen.add(threadKey);
                  const reminder = yield* store.reminderSnapshot(id);
                  if (Option.isSome(reminder)) reminders.push(reminder.value);
                  const members = yield* store.getThread(id);
                  for (const member of members) messageIds.add(member.id);
                  yield* store.snooze(id, due);
                  for (const member of members)
                    if (
                      member.labels.includes("INBOX") &&
                      !member.labels.some((label) => ["DRAFT", "TRASH", "SPAM"].includes(label))
                    ) {
                      localChanges.push({ id: member.id, op: { kind: "inbox" } });
                      expected.push({
                        id: member.id,
                        accountId: member.accountId,
                        labels: member.labels,
                        isUnread: member.isUnread,
                        isStarred: member.isStarred,
                      });
                    }
                  yield* store.appendAudit({
                    actor: user,
                    accountId: message.accountId,
                    action: "snooze",
                    detail: { id, due },
                  });
                }
                const localExpected = yield* Effect.forEach(expected, (state) =>
                  store.getMessage(state.id).pipe(
                    Effect.map((message) => ({
                      id: message.id,
                      accountId: message.accountId,
                      labels: message.labels,
                      isUnread: message.isUnread,
                      isStarred: message.isStarred,
                    })),
                  ),
                );
                yield* store.saveUndoJournal(undoId, {
                  changes: [],
                  localChanges,
                  expected,
                  localExpected,
                });
                return { messageIds: [...messageIds], changes: [], localChanges, reminders };
              }),
            );
            history.set(undoId, back);
            if (history.size > 50) {
              const oldest = history.keys().next().value;
              if (oldest) history.delete(oldest);
            }
            return { undoId };
          }),
        )
        .pipe(Effect.tap(() => changed));
    const undoBatch: Mailbox["Service"]["undoBatch"] = (undoId) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const live = history.get(undoId);
            const journal = yield* store.undoJournal(undoId);
            const back: UndoBatch | undefined =
              (journal ? live : undefined) ??
              (journal
                ? {
                    messageIds: journal.localExpected.map((state) => state.id),
                    changes: journal.changes,
                    localChanges: journal.localChanges,
                    reminders: [],
                  }
                : undefined);
            if (!back)
              return yield* new InvalidInput({
                message: "This operation can no longer be undone.",
              });
            const checkLocal = Effect.gen(function* () {
              if (live || !journal) return;
              const pending = yield* store.listPendingOps;
              for (const expected of journal.localExpected) {
                const message = yield* store.getMessage(expected.id);
                const ref = yield* store.messageRef(expected.id);
                if (
                  pending.some(
                    (op) => op.accountId === message.accountId && op.providerId === ref.providerId,
                  )
                )
                  yield* new InvalidInput({
                    message: "Finish pending changes for these messages before undoing.",
                  });
                if (
                  message.accountId !== expected.accountId ||
                  undoStateKey(message) !== undoStateKey(expected)
                )
                  yield* new InvalidInput({
                    message: "The message changed locally. This operation cannot be safely undone.",
                  });
              }
            });
            if (!live && journal) {
              const now = yield* Clock.currentTimeMillis;
              if (now - journal.createdAt > UNDO_HISTORY_TTL_MS)
                return yield* new InvalidInput({
                  message: "Restored operations expire after 24 hours.",
                });
              // Folder-model IMAP moves change UID; never replay the original UID after restart.
              for (const change of back.changes) {
                const expected = journal.expected.find((state) => state.id === change.id);
                if (!expected) continue;
                const account = yield* store.getAccount(expected.accountId);
                const destination = folderTarget(change.op, expected.labels);
                if (account.provider === "imap" && destination)
                  return yield* new InvalidInput({
                    message:
                      "IMAP moves change message UIDs and cannot be undone after restarting. Move the message back manually.",
                  });
                const custom =
                  destination && !["INBOX", "ARCHIVE", "TRASH", "SPAM"].includes(destination);
                const checkDestination =
                  destination &&
                  (account.provider === "outlook" ||
                    (account.provider === "gmail" && destination.startsWith("Label_")));
                if (checkDestination) {
                  if (
                    custom &&
                    !(yield* store.listLabels([account.id])).some(
                      (label) => label.id === destination,
                    )
                  )
                    return yield* new InvalidInput({
                      message: "The original destination folder no longer exists.",
                    });
                  if (!verifyFolder)
                    return yield* new InvalidInput({
                      message: "Server folder verification is required before undo.",
                    });
                  yield* verifyFolder(account.id, destination);
                }
              }
              yield* checkLocal;
              if (!verify && journal.expected.length)
                return yield* new InvalidInput({
                  message: "Server verification is required before undo.",
                });
              for (const expected of journal.expected) {
                if (!verify) continue;
                const remote = yield* verify(expected.id);
                if (undoStateKey(remote) !== undoStateKey(expected))
                  return yield* new InvalidInput({
                    message:
                      "The message changed on the server. This operation cannot be safely undone.",
                  });
              }
            }
            yield* store.transaction(
              Effect.gen(function* () {
                yield* checkLocal;
                yield* applyChanges(store, back.changes);
                for (const change of back.localChanges ?? []) {
                  const ref = yield* store.messageRef(change.id).pipe(Effect.option);
                  if (Option.isSome(ref)) yield* store.applyLocalOp(change.id, change.op);
                }
                for (const reminder of back.reminders) {
                  const members = (yield* Effect.forEach(reminder.members, (member) =>
                    store
                      .messageIdForProvider(reminder.accountId, member.providerId)
                      .pipe(Effect.map((id) => (id ? [member] : []))),
                  )).flat();
                  if (members.length) yield* store.restoreReminder({ ...reminder, members });
                }
                yield* store.deleteUndoJournal(undoId);
              }),
            );
            history.delete(undoId);
            return yield* Effect.void;
          }),
        )
        .pipe(
          Effect.tap(() => changed),
          Effect.tap(() => flushLater),
        );
    const markUnreadFrom: Mailbox["Service"]["markUnreadFrom"] = (id) =>
      Effect.gen(function* () {
        const messages = messagesFrom(yield* store.getThread(id), id).filter(
          (message) => !message.labels.some((label) => ["DRAFT", "TRASH", "SPAM"].includes(label)),
        );
        if (!messages.length)
          return yield* new InvalidInput({
            message: "The selected message is no longer available.",
          });
        return yield* modifyWithUndo(
          messages.map((message) => message.id),
          { kind: "read", value: false },
          true,
        );
      });
    return {
      forgetMessages: (ids: readonly string[]) =>
        Effect.gen(function* () {
          const removed = new Set(ids);
          for (const [id, batch] of history) {
            if (batch.messageIds.some((messageId) => removed.has(messageId))) {
              yield* store.deleteUndoJournal(id);
              history.delete(id);
            }
          }
        }),
      modifyWithUndo,
      undoBatch,
      markUnreadFrom,
      snoozeWithUndo,
      undoHistory: store.undoHistory,
    };
  });
