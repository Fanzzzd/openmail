import { Effect, Option } from "effect";
import type { ImapFlow, ListResponse, ResponseEvent } from "imapflow";
import type { MailOp } from "../../../domain/domain.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../../../domain/errors.js";
import {
  decodeProviderId,
  encodeProviderId,
  folderRegressed,
  uidSet,
  type FolderCursor,
} from "../../../providers/imap/imap-cursor.js";
import { copyProgressKey } from "../../../providers/imap/imap-helpers.js";
import { messageIdKey } from "../../../mime/message-id.js";
import { type ProviderPushContext } from "../../../services.js";
import { call, describe, failure, isRefusal, searchUids, type Session } from "./session.js";

// Push

export const ensureFolder = Effect.fnUntraced(function* (
  s: Session,
  list: readonly ListResponse[],
  use: string,
  name: string,
) {
  const found =
    list.find((f) => f.specialUse === use && !f.flags.has("\\Noselect"))?.path ??
    list.find((f) => f.path === name)?.path;
  if (found) return found;
  return (yield* call(s, (c) => c.mailboxCreate(name))).path;
});

/** Check the selected mailbox before ImapFlow silently drops unsupported flags. */
const requireFlag = (flags: Set<string> | undefined, flag: string) =>
  flags && !flags.has(flag) && !flags.has("\\*")
    ? Effect.fail(new PermanentError({ message: `This IMAP folder does not allow ${flag}.` }))
    : Effect.void;

const checkedFlags = Effect.fnUntraced(function* (
  s: Session,
  range: string,
  flag: string,
  on: boolean,
  permanentFlags?: Set<string>,
) {
  yield* requireFlag(permanentFlags, flag);
  const changed = yield* call(s, (c) =>
    on
      ? c.messageFlagsAdd(range, [flag], { uid: true })
      : c.messageFlagsRemove(range, [flag], { uid: true }),
  );
  if (!changed) yield* new ProviderError({ message: `Updating ${flag} failed` });
});

/** Server-side Message-ID lookup persists copy progress across sessions and restarts. */
const destinationRefs = Effect.fnUntraced(function* (
  s: Session,
  from: string,
  validity: string,
  destination: string,
  identities: ReadonlyMap<number, string>,
  restoreSource = true,
) {
  const refs = new Map<number, string>();
  if (!identities.size) return refs;
  const mailbox = yield* call(s, (c) => c.mailboxOpen(destination, { readOnly: true }));
  for (const [uid, messageId] of identities) {
    const found = yield* searchUids(s, { header: { "message-id": messageId }, deleted: false });
    if (found.length)
      refs.set(uid, encodeProviderId(destination, mailbox.uidValidity, Math.max(...found)));
  }
  if (restoreSource) {
    const source = yield* call(s, (c) => c.mailboxOpen(from));
    if (String(source.uidValidity) !== validity)
      yield* new PermanentError({ message: `Folder ${from} was rebuilt; the message id is stale` });
  }
  return refs;
});

const hasCopyProgress = (
  context: ProviderPushContext | undefined,
  providerId: string,
  destination: string,
  accepted = false,
) => context?.progress?.has(copyProgressKey(providerId, destination, accepted)) === true;

/** Persist the issued/accepted boundaries around COPY before changing its source. */
const issueCopy = Effect.fnUntraced(function* (
  s: Session,
  uids: readonly number[],
  from: string,
  validity: string,
  to: string,
  context?: ProviderPushContext,
) {
  const ids = uids.map((uid) => encodeProviderId(from, validity, uid));
  if (context?.beforeCopy) yield* context.beforeCopy(to, ids);
  const status = { refused: false };
  const observe = (event: ResponseEvent) => {
    if (event.response === "NO" || event.response === "BAD") status.refused = true;
  };
  const copied = yield* call(s, async (c) => {
    c.on("response", observe);
    try {
      try {
        return await c.messageCopy(uidSet(uids), to, { uid: true });
      } catch (error) {
        if (isRefusal(error)) status.refused = true;
        throw error;
      }
    } finally {
      c.off("response", observe);
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (status.refused && context?.clearCopy) yield* context.clearCopy(to, ids);
        return yield* error;
      }),
    ),
  );
  if (!copied) {
    // ImapFlow also turns socket/parser failures into false; a live session alone cannot prove refusal.
    if (status.refused && context?.clearCopy) yield* context.clearCopy(to, ids);
    return yield* new ProviderError({ message: `Copying to ${to} failed` });
  }
  if (context?.afterCopy) yield* context.afterCopy(to, ids);
  return copied;
});

const moveTo = Effect.fnUntraced(function* (
  s: Session,
  uids: readonly number[],
  from: string,
  validity: string,
  to: string,
  identities: ReadonlyMap<number, string>,
  permanentFlags?: Set<string>,
  context?: ProviderPushContext,
) {
  if (from === to) return [];
  yield* requireFlag(permanentFlags, "\\Deleted");
  const replayIds = new Map(
    [...identities].filter(([uid]) =>
      hasCopyProgress(context, encodeProviderId(from, validity, uid), to),
    ),
  );
  const resolved = yield* destinationRefs(s, from, validity, to, replayIds);
  const acceptedWithoutId = new Set(
    uids.filter(
      (uid) =>
        !identities.has(uid) &&
        hasCopyProgress(context, encodeProviderId(from, validity, uid), to, true),
    ),
  );
  const missing = uids.filter((uid) => !resolved.has(uid) && !acceptedWithoutId.has(uid));
  if (
    missing.some(
      (uid) =>
        !identities.has(uid) && hasCopyProgress(context, encodeProviderId(from, validity, uid), to),
    )
  )
    return yield* new ProviderError({
      message: `The copy to ${to} is unconfirmed; waiting for synchronization.`,
    });
  if (missing.length) {
    const copied = yield* issueCopy(s, missing, from, validity, to, context);
    if (copied.uidValidity !== undefined && copied.uidMap)
      for (const [uid, newUid] of copied.uidMap)
        resolved.set(uid, encodeProviderId(to, copied.uidValidity, newUid));
    if (missing.some((uid) => !resolved.has(uid))) {
      const copiedIds = new Map([...identities].filter(([uid]) => missing.includes(uid)));
      for (const [uid, id] of yield* destinationRefs(s, from, validity, to, copiedIds))
        resolved.set(uid, id);
    }
  }
  if (uids.some((uid) => identities.has(uid) && !resolved.has(uid)))
    return yield* new ProviderError({
      message: `The copied message UID in ${to} is unavailable; waiting for synchronization.`,
    });
  const range = uidSet(uids);
  if (s.client.capabilities.has("UIDPLUS")) {
    const deleted = yield* call(s, (c) => c.messageDelete(range, { uid: true }));
    if (!deleted)
      yield* new ProviderError({ message: `Removing the original message from ${from} failed` });
  } else yield* checkedFlags(s, range, "\\Deleted", true, permanentFlags);
  if (uids.some((uid) => !resolved.has(uid))) return { reconcile: true } as const;
  return [...resolved].map(([uid, id]) => ({
    from: encodeProviderId(from, validity, uid),
    to: id,
  }));
});

const targetFor = Effect.fnUntraced(function* (
  s: Session,
  list: readonly ListResponse[],
  from: string,
  op: MailOp,
) {
  if (
    op.kind === "copy" ||
    op.kind === "read" ||
    op.kind === "star" ||
    op.kind === "important" ||
    op.kind === "categories" ||
    op.kind === "classification"
  )
    return null;
  if (
    (op.kind === "move" || (op.kind === "label" && op.value)) &&
    !list.some((f) => f.path === op.labelId)
  ) {
    yield* new PermanentError({ message: `Folder ${op.labelId} does not exist` });
  }
  const target =
    op.kind === "archive"
      ? yield* ensureFolder(s, list, "\\Archive", "Archive")
      : op.kind === "trash"
        ? yield* ensureFolder(s, list, "\\Trash", "Trash")
        : op.kind === "spam"
          ? yield* ensureFolder(s, list, "\\Junk", "Junk")
          : op.kind === "inbox"
            ? "INBOX"
            : op.kind === "move"
              ? op.labelId
              : op.value
                ? op.labelId
                : // Removing a folder label only means something for the folder the message is in.
                  from === op.labelId
                  ? "INBOX"
                  : from;
  return target;
});

/** A COPY can be complete even if source deletion or the local remap was interrupted. */
const resumeCopied = Effect.fnUntraced(function* (
  s: Session,
  ref: { path: string; uidValidity: string; uid: number },
  uids: readonly number[],
  op: MailOp,
  list: readonly ListResponse[],
  identities: ReadonlyMap<number, string>,
  context?: ProviderPushContext,
) {
  if (!context?.progress?.size) return null;
  const target = yield* targetFor(s, list, ref.path, op);
  const destinations =
    op.kind === "copy" ? [...new Set(op.labelIds)] : target === null ? [] : [target];
  if (!destinations.length) return null;
  // No issued marker means another client removed the source before this operation reached COPY.
  if (
    destinations.some(
      (destination) =>
        destination !== ref.path &&
        uids.some(
          (uid) =>
            !hasCopyProgress(
              context,
              encodeProviderId(ref.path, ref.uidValidity, uid),
              destination,
            ),
        ),
    )
  )
    return null;
  const mappings: import("../../../services.js").ProviderIdMapping[] = [];
  let reconcile = false;
  for (const destination of destinations) {
    if (destination === ref.path) continue;
    const resolved = yield* destinationRefs(
      s,
      ref.path,
      ref.uidValidity,
      destination,
      identities,
      false,
    );
    for (const uid of uids) {
      const id = resolved.get(uid);
      if (!id) {
        if (
          !identities.has(uid) &&
          hasCopyProgress(
            context,
            encodeProviderId(ref.path, ref.uidValidity, uid),
            destination,
            true,
          )
        ) {
          reconcile = true;
          continue;
        }
        yield* new ProviderError({
          message: `Waiting for the copied message in ${destination} before completing the change.`,
        });
      } else if (op.kind !== "copy")
        mappings.push({ from: encodeProviderId(ref.path, ref.uidValidity, uid), to: id });
    }
  }
  return reconcile && op.kind !== "copy" ? ({ reconcile: true } as const) : mappings;
});

/** Refuse a reused UID before replacing the queued identity or touching its source. */
const readSourceIdentities = Effect.fnUntraced(function* (
  s: Session,
  uids: readonly number[],
  identities: Map<number, string>,
) {
  const messages = yield* call(s, (c) =>
    c.fetchAll(uidSet(uids), { uid: true, envelope: true }, { uid: true }),
  );
  const actual = new Map(
    messages.flatMap((message) =>
      message.envelope?.messageId ? [[message.uid, message.envelope.messageId] as const] : [],
    ),
  );
  for (const uid of uids) {
    const expected = identities.get(uid);
    const messageId = actual.get(uid);
    if (expected && !messageId)
      yield* new ProviderError({
        message: "Message-ID is unavailable; sync before changing this message.",
      });
    if (expected && messageId && messageIdKey(expected) !== messageIdKey(messageId))
      yield* new PermanentError({
        message: "Message identity changed; sync before changing this message.",
      });
    if (messageId) identities.set(uid, messageId);
  }
});

export const applyOp = Effect.fnUntraced(function* (
  s: Session,
  ref: { path: string; uidValidity: string; uid: number },
  op: MailOp,
  uids: readonly number[] = [ref.uid],
  expected?: FolderCursor,
  context?: ProviderPushContext,
) {
  const list = yield* call(s, (c) => c.list());
  const identities = new Map<number, string>();
  for (const uid of uids) {
    const messageId = context?.messageIds.get(encodeProviderId(ref.path, ref.uidValidity, uid));
    if (messageId) identities.set(uid, messageId);
  }
  const mailbox = yield* Effect.tryPromise({
    try: () => s.client.mailboxOpen(ref.path),
    catch: (error): ProviderFailure =>
      isRefusal(error)
        ? new PermanentError({ message: `Folder ${ref.path} is gone: ${describe(error)}` })
        : failure(s.accountId, s.settings.imapHost, error),
  }).pipe(Effect.result);
  if (mailbox._tag === "Failure") {
    if (mailbox.failure._tag === "PermanentError") {
      const resumed = yield* resumeCopied(s, ref, uids, op, list, identities, context);
      if (resumed !== null) return resumed;
    }
    return yield* mailbox.failure;
  }
  const selected = mailbox.success;
  const regressed =
    String(selected.uidValidity) === ref.uidValidity &&
    folderRegressed(expected, ref.uidValidity, selected.uidNext);
  if (
    String(selected.uidValidity) !== ref.uidValidity ||
    (expected && expected.uidValidity !== ref.uidValidity) ||
    regressed
  ) {
    yield* new PermanentError({
      message: `Folder ${ref.path} was rebuilt; the message id is stale`,
      ...(regressed ? { imapReset: { path: ref.path, uidValidity: ref.uidValidity } } : {}),
    });
  }
  const found = yield* searchUids(s, { uid: uidSet(uids), deleted: false });
  if (uids.some((uid) => !found.includes(uid))) {
    const resumed = yield* resumeCopied(s, ref, uids, op, list, identities, context);
    if (resumed !== null) {
      const stillPresent = yield* call(s, (c) => c.mailboxOpen(ref.path)).pipe(
        Effect.flatMap(() => searchUids(s, { uid: uidSet(uids) })),
      );
      if (stillPresent.length && op.kind !== "copy") {
        yield* readSourceIdentities(s, stillPresent, identities);
        yield* requireFlag(selected.permanentFlags, "\\Deleted");
        if (s.client.capabilities.has("UIDPLUS")) {
          const removed = yield* call(s, (c) =>
            c.messageDelete(uidSet(stillPresent), { uid: true }),
          );
          if (!removed)
            yield* new ProviderError({
              message: `Removing the original message from ${ref.path} failed`,
            });
        } else
          yield* checkedFlags(s, uidSet(stillPresent), "\\Deleted", true, selected.permanentFlags);
      }
      return resumed;
    }
    yield* new PermanentError({ message: `Message ${ref.uid} is no longer in ${ref.path}` });
  }
  const uid = uidSet(uids);
  const flag = (name: string, on: boolean) =>
    checkedFlags(s, uid, name, on, selected.permanentFlags);
  if (
    op.kind !== "read" &&
    op.kind !== "star" &&
    op.kind !== "important" &&
    op.kind !== "categories" &&
    op.kind !== "classification"
  ) {
    yield* readSourceIdentities(s, uids, identities);
  }
  if (op.kind === "categories" || op.kind === "classification") {
    yield* new PermanentError({ message: "Categories are available for Outlook accounts." });
    return [];
  }
  if (op.kind === "copy") {
    for (const destination of new Set(op.labelIds)) {
      if (!list.some((folder) => folder.path === destination))
        yield* new PermanentError({ message: `Folder ${destination} does not exist` });
    }
    for (const destination of new Set(op.labelIds)) {
      if (destination === ref.path) continue;
      const replayIds = new Map(
        [...identities].filter(([sourceUid]) =>
          hasCopyProgress(
            context,
            encodeProviderId(ref.path, ref.uidValidity, sourceUid),
            destination,
          ),
        ),
      );
      const existing = yield* destinationRefs(s, ref.path, ref.uidValidity, destination, replayIds);
      const missing = uids.filter(
        (sourceUid) =>
          !existing.has(sourceUid) &&
          !hasCopyProgress(
            context,
            encodeProviderId(ref.path, ref.uidValidity, sourceUid),
            destination,
            true,
          ),
      );
      if (!missing.length) continue;
      if (
        missing.some(
          (sourceUid) =>
            !identities.has(sourceUid) &&
            hasCopyProgress(
              context,
              encodeProviderId(ref.path, ref.uidValidity, sourceUid),
              destination,
            ),
        )
      )
        return yield* new ProviderError({
          message: `The copy to ${destination} is unconfirmed; waiting for synchronization.`,
        });
      yield* issueCopy(s, missing, ref.path, ref.uidValidity, destination, context);
    }
    return [];
  }
  if (op.kind === "important") return [];
  if (op.kind === "read" || op.kind === "star") {
    yield* flag(op.kind === "read" ? "\\Seen" : "\\Flagged", op.value);
    return [];
  }
  const target = yield* targetFor(s, list, ref.path, op);
  if (target === null) return [];
  return yield* moveTo(
    s,
    uids,
    ref.path,
    ref.uidValidity,
    target,
    identities,
    selected.permanentFlags,
    context,
  );
});

// Drafts

/** Opens the message's folder if it still has the same UIDVALIDITY. False when it was rebuilt. */
export const openFolderOf = (
  s: Session,
  ref: { path: string; uidValidity: string },
  readOnly: boolean,
) =>
  Effect.tryPromise({
    try: () => s.client.mailboxOpen(ref.path, { readOnly }),
    catch: (error): ProviderFailure =>
      isRefusal(error)
        ? new PermanentError({ message: `Folder ${ref.path} is gone: ${describe(error)}` })
        : failure(s.accountId, s.settings.imapHost, error),
  }).pipe(Effect.map((mailbox) => mailbox.uidValidity === BigInt(ref.uidValidity)));

/** Deletes one message by provider id. One that is already gone counts as deleted. */
export const deleteMessage = Effect.fnUntraced(function* (s: Session, providerId: string) {
  const ref = decodeProviderId(providerId);
  if (Option.isNone(ref)) return;
  const same = yield* openFolderOf(s, ref.value, false).pipe(
    Effect.catchTag("PermanentError", () => Effect.succeed(false)),
  );
  if (!same) return;
  const mailbox = yield* call(s, (c) => c.mailboxOpen(ref.value.path));
  yield* requireFlag(mailbox.permanentFlags, "\\Deleted");
  const deleted = yield* call(s, (c) =>
    c.capabilities.has("UIDPLUS")
      ? c.messageDelete(String(ref.value.uid), { uid: true })
      : c.messageFlagsAdd(String(ref.value.uid), ["\\Deleted"], { uid: true }),
  );
  if (!deleted) yield* new ProviderError({ message: `Deleting message ${providerId} failed` });
});

// Adapter

export const requireTargetedExpunge = (client: ImapFlow) =>
  client.capabilities.has("UIDPLUS") ||
  client.enabled.has("IMAP4REV2") ||
  (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"))
    ? Effect.void
    : Effect.fail(
        new PermanentError({
          message: "This IMAP server cannot safely expunge selected messages (UIDPLUS required).",
        }),
      );
