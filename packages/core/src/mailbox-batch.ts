import { Effect, Option, Semaphore } from "effect";

import type { Actor, MailOp, Message, Provider } from "./domain.js";
import { InvalidInput } from "./errors.js";
import type { Mailbox } from "./mailbox.js";
import type { ReminderSnapshot, Store } from "./services.js";
import { applyOpToLabels, folderTarget } from "./store.js";

const user: Actor = { kind: "user", surface: "app" };
interface Change {
  id: string;
  op: MailOp;
}
interface UndoBatch {
  changes: Change[];
  reminders: ReminderSnapshot[];
}

/** Restore only the fields this op changed, using each message's actual state. */
function inverse(message: Message, provider: Provider, op: MailOp): MailOp[] {
  if (op.kind === "read") return [{ kind: "read", value: !message.isUnread }];
  if (op.kind === "star") return [{ kind: "star", value: message.isStarred }];
  if (provider !== "gmail") {
    if (!folderTarget(op, message.labels)) return [];
    const folder = message.labels.find(
      (l) => !["UNREAD", "STARRED", "IMPORTANT", "SNOOZED"].includes(l),
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
      yield* store.enqueueOp(change.accountId, change.providerId, change.op);
      yield* store.audit({
        actor: user,
        accountId: change.accountId,
        action: change.op.kind,
        detail: { id: change.id, op: change.op },
      });
    }
  });

/** No database migration: handles live with the app and retain at most 50 batches. */
export const makeBatchMailbox = (
  store: Store["Service"],
  changed: Effect.Effect<void>,
  flushLater: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const history = new Map<string, UndoBatch>();
    const modifyWithUndo: Mailbox["Service"]["modifyWithUndo"] = (threads, op, flat = false) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (!threads.length)
              return yield* new InvalidInput({ message: "Select at least one conversation." });
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
                  for (const id of found) ids.add(id);
                }
                const forward: Change[] = [];
                const inverses: Change[] = [];
                const reminders = new Map<string, ReminderSnapshot>();
                for (const id of ids) {
                  const message = yield* store.getMessage(id);
                  const account = yield* store.getAccount(message.accountId);
                  if (
                    account.provider !== "gmail" &&
                    op.kind !== "read" &&
                    op.kind !== "star" &&
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
                return { changes: inverses, reminders: [...reminders.values()] };
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
        .pipe(
          Effect.tap(() => changed),
          Effect.tap(() => flushLater),
        );
    const undoBatch: Mailbox["Service"]["undoBatch"] = (undoId) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const back = history.get(undoId);
            if (!back)
              return yield* new InvalidInput({
                message: "This operation can no longer be undone.",
              });
            yield* store.transaction(
              Effect.gen(function* () {
                yield* applyChanges(store, back.changes);
                for (const reminder of back.reminders) {
                  const members = (yield* Effect.forEach(reminder.members, (member) =>
                    store.messageRef(`${reminder.accountId}/${member.providerId}`).pipe(
                      Effect.option,
                      Effect.map((ref) => (Option.isSome(ref) ? [member] : [])),
                    ),
                  )).flat();
                  if (members.length) yield* store.restoreReminder({ ...reminder, members });
                }
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
    return { modifyWithUndo, undoBatch };
  });
