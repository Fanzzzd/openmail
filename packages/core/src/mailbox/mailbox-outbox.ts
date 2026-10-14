import { Clock, Deferred, Effect, Fiber, Option } from "effect";
import { logWarning } from "../domain/diagnostic-log.js";
import { attachmentProblem, attachmentProblemMessage } from "../mime/attachment-policy.js";
import type { Actor, Command, FlushResult, Outcome } from "../domain/command.js";
import type { DraftInput, OutgoingMessage } from "../domain/changes.js";
import {
  AuthError,
  InvalidInput,
  type NotFound,
  type FeatureScopeMissing,
  type ProviderFailure,
  SendUncertain,
} from "../domain/errors.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { DISCARDED_DRAFT_MESSAGE, WRITE_RECOVERY_WINDOW_MS } from "./mailbox-shared.js";
import type { MailboxCompose, MailboxOutbox } from "./mailbox.js";
import { mobileAttachmentProblem, type QueuedSend } from "./mobile-outbox.js";
import { isDefiniteSendFailure } from "../providers/provider-send.js";
import { READ_ONLY_MESSAGE } from "./read-only.js";
import { isEmailAddress } from "../compose/recipients.js";
import type { StoredDraft } from "../store/service.js";
import { providerCapabilities } from "../providers/capabilities.js";

/** A finished discard keeps its draft id this long, so a save arriving late can't recreate it. */
const DISCARD_TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

const isWaitingSend = (item: QueuedSend) => item.status === "waiting";

const desktopSendForOwner = (owner?: string) => (item: QueuedSend) =>
  item.desktopUndo === true &&
  isWaitingSend(item) &&
  (owner === undefined || item.desktopOwner === owner);

export const makeOutboxMailbox = (
  deps: MailboxDependencies & {
    prepare: (message: OutgoingMessage) => Effect.Effect<
      {
        message: OutgoingMessage;
        original: Option.Option<{ providerId: string; threadId: string }>;
      },
      NotFound | ProviderFailure
    >;
    removeDraft: (draft: StoredDraft) => Effect.Effect<void>;
    settleProposal: (proposalId: number, approve: boolean) => Effect.Effect<void>;
    modify: (
      command: Extract<Command, { kind: "modify" }>,
      actor: Actor,
    ) => Effect.Effect<FlushResult, FeatureScopeMissing | NotFound | InvalidInput>;
    flushLater: Effect.Effect<void | boolean>;
    persistDraft: (
      input: DraftInput,
      enqueue: boolean,
    ) => Effect.Effect<StoredDraft, NotFound | InvalidInput>;
    discardDraft: (id: string, alongside?: Effect.Effect<void>) => Effect.Effect<void>;
    draftStatus: MailboxCompose["draftStatus"];
    saveDraft: MailboxCompose["saveDraft"];
    openDraft: MailboxCompose["openDraft"];
  },
  runtime: MailboxRuntimeState,
) => {
  const {
    options,
    readOnly,
    store,
    prepare,
    providers,
    removeDraft,
    settleProposal,
    modify,
    flushLater,
    changed,
    persistDraft,
    crypto,
    mailboxScope,
    discardDraft,
    draftStatus,
    saveDraft,
    openDraft,
  } = deps;

  /** Called within the send transaction, so clearing cannot lose the old draft's identity. */
  const clearSendPreparation = (accountId: string, draftId: string) =>
    Effect.gen(function* () {
      const previous = yield* store.sendPreparationState(draftId);
      if (Option.isSome(previous))
        yield* store.enqueueOp(accountId, draftId, {
          kind: "deleteDraft",
          remote: { draftId: null, messageId: null, rfcMessageId: previous.value.messageId },
        });
      yield* store.setSendPreparationState(draftId, null);
    });

  const send = Effect.fn("Mailbox.send")(function* (
    command: Extract<Command, { kind: "send" }>,
    actor: Actor,
    claimedSend = false,
  ) {
    if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
    const { accountId, message } = command;
    const draftId = command.draftId;
    if (message.to.length + message.cc.length + message.bcc.length === 0) {
      yield* new InvalidInput({ message: "A message needs at least one recipient." });
    }
    const account = yield* store.getAccount(accountId);
    if (message.from && message.from.address.toLowerCase() !== account.email.toLowerCase()) {
      const aliases = yield* store.sendAs;
      if (
        !providerCapabilities(account.provider).sendAs ||
        !aliases.some(
          (a) =>
            a.accountId === accountId &&
            a.address.toLowerCase() === message.from?.address.toLowerCase(),
        )
      )
        return yield* new InvalidInput({
          message: "Choose a verified send-as address for this account",
        });
    }
    if (account.enabled === false)
      return yield* new InvalidInput({ message: "Enable the account before sending" });
    if (account.needsReauth) {
      yield* new AuthError({ accountId, message: "Sign in again before sending." });
    }
    const prepared = yield* prepare(message);
    const problem = attachmentProblem(
      account.provider,
      prepared.message.attachments,
      prepared.message,
    );
    if (problem) return yield* new InvalidInput({ message: attachmentProblemMessage(problem) });
    const detail = {
      to: message.to.map((a) => a.address),
      cc: message.cc.map((a) => a.address),
      bcc: message.bcc.map((a) => a.address),
      subject: message.subject,
      mode: message.mode ?? "new",
      attachments: prepared.message.attachments.length,
      ...(message.markdown ? { markdown: true } : {}),
      ...(message.forwardAsAttachment ? { forwardAsAttachment: true } : {}),
      ...(command.draftId ? { draftId: command.draftId } : {}),
    };
    if (command.draftId) {
      const id = command.draftId;
      yield* store.transaction(
        Effect.gen(function* () {
          if (
            !claimedSend &&
            (yield* store.sendUncertain(id)) &&
            (!command.confirmResend || actor.kind !== "user" || actor.surface !== "app")
          )
            yield* new SendUncertain({
              message: "This message may have been sent. Check Sent before sending it again.",
            });
          if (
            !claimedSend &&
            (yield* store.queuedSends).some(
              (item) => item.id === id && (item.status === "waiting" || item.status === "sending"),
            )
          )
            yield* new InvalidInput({ message: "This draft already has a queued send" });
          yield* store.setSendUncertain(id, true);
          if (command.confirmResend && actor.kind === "user" && actor.surface === "app")
            yield* clearSendPreparation(accountId, id);
        }),
      );
    }
    const delivery = yield* providers
      .get(account.provider)
      .send(
        account,
        prepared.message,
        prepared.original,
        draftId
          ? {
              load: store.sendPreparationState(draftId),
              save: (state) => store.setSendPreparationState(draftId, state),
            }
          : undefined,
      )
      .pipe(
        Effect.tapError((error) =>
          Effect.all([
            error._tag === "AuthError" ? store.markReauth(accountId, error) : Effect.void,
            command.draftId && isDefiniteSendFailure(error)
              ? store.setSendUncertain(command.draftId, false)
              : Effect.void,
            store.appendAudit({
              actor,
              accountId,
              action: "send_failed",
              detail: { ...detail, error: error.message },
            }),
          ]),
        ),
      );
    if (delivery?.rejected?.length) {
      yield* store.recordFailedOp({
        accountId,
        providerId: command.draftId ?? "",
        kind: "sendPartial",
        reason: delivery.rejected.join(", "),
        subject: message.subject,
        sender: message.from?.address ?? account.email,
        rejected: delivery.rejected,
      });
      if (command.draftId) yield* store.setSendUncertain(command.draftId, true);
    }
    if (delivery?.sentCopyMissing)
      yield* store.recordFailedOp({
        accountId,
        providerId: command.draftId ?? "",
        kind: "sentCopyMissing",
        reason: "SMTP accepted the message, but saving its Sent copy failed.",
        subject: message.subject,
        sender: message.from?.address ?? account.email,
      });
    yield* store.appendAudit({ actor, accountId, action: "send", detail });
    yield* store.rememberMailedAddresses(
      accountId,
      [...message.to, ...message.cc, ...message.bcc].map((recipient) => recipient.address),
    );

    // The mail is out. What follows only tidies up and must not fail the send.
    const draft = command.draftId
      ? yield* store.getDraft(command.draftId)
      : Option.none<StoredDraft>();
    if (!delivery?.rejected?.length) {
      if (Option.isSome(draft)) {
        yield* store.transaction(removeDraft(draft.value));
        if (draft.value.proposalId !== null) yield* settleProposal(draft.value.proposalId, true);
      }
      if (command.draftId) {
        yield* store.setSendUncertain(command.draftId, false);
        yield* store.deleteQueuedSend(command.draftId);
      }
    }
    let flushed: FlushResult | undefined;
    if (command.archive && message.inReplyTo) {
      flushed = yield* modify(
        { kind: "modify", threads: [message.inReplyTo], op: { kind: "archive" } },
        actor,
      ).pipe(
        Effect.catch((error) =>
          logWarning("sent-archive-failed", `Sent, but archiving failed: ${error.message}`).pipe(
            Effect.as(undefined),
          ),
        ),
      );
    } else if (Option.isSome(draft)) {
      yield* flushLater;
    }
    yield* changed;
    return flushed;
  });

  const queueSend = Effect.fn("Mailbox.queueSend")(function* (
    input: DraftInput,
    due: number,
    confirmResend = false,
    delivery: { desktopUndo?: boolean; archive?: boolean; desktopOwner?: string } = {},
  ) {
    if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
    if (
      !Number.isFinite(due) ||
      [...input.message.to, ...input.message.cc, ...input.message.bcc].some(
        (recipient) => !isEmailAddress(recipient.address),
      ) ||
      input.message.to.length + input.message.cc.length + input.message.bcc.length === 0
    )
      return yield* new InvalidInput({
        message: "A queued message needs recipients and a valid send time",
      });
    const account = yield* store.getAccount(input.accountId);
    const problem = attachmentProblem(account.provider, input.message.attachments, input.message);
    if (problem) return yield* new InvalidInput({ message: attachmentProblemMessage(problem) });
    if (
      !delivery.desktopUndo &&
      mobileAttachmentProblem(account.provider, input.message.attachments)
    )
      return yield* new InvalidInput({ message: "Attachments rejected before sending" });
    yield* store.transaction(
      Effect.gen(function* () {
        if (yield* store.sendUncertain(input.id)) {
          if (!confirmResend)
            yield* new SendUncertain({
              message: "This message may have been sent. Check Sent before sending it again.",
            });
          const queued = (yield* store.queuedSends).find((item) => item.id === input.id);
          if (queued?.status === "failed") yield* store.deleteQueuedSend(input.id);
          yield* store.setSendUncertain(input.id, false);
        }
        if (confirmResend) yield* clearSendPreparation(input.accountId, input.id);
        const previous = (yield* store.queuedSends).find((item) => item.id === input.id);
        if (previous?.status === "retryable" || previous?.status === "rejected")
          yield* store.deleteQueuedSend(input.id);
        else if (previous)
          yield* new InvalidInput({ message: "This draft already has a queued send" });
        const saved = yield* persistDraft(input, true);
        yield* store.putQueuedSend({
          id: input.id,
          accountId: input.accountId,
          message: saved.message,
          due,
          status: "waiting",
          deliveryId: crypto.randomUUID(),
          ...delivery,
        });
      }),
    );
    return yield* changed;
  });

  const takeUndoWorker = (id: string) => {
    const entry = runtime.undoSendWorkers.get(id);
    runtime.undoSendWorkers.delete(id);
    return entry?.worker;
  };

  const cancelSendWhere = (id: string, canCancel: (item: QueuedSend) => boolean) =>
    Effect.gen(function* () {
      const cancelled = yield* store
        .transaction(
          Effect.gen(function* () {
            const item = (yield* store.queuedSends).find((entry) => entry.id === id);
            if (!item || !canCancel(item)) return { cancelled: false, worker: undefined };
            yield* store.deleteQueuedSend(id);
            return { cancelled: true, worker: takeUndoWorker(id) };
          }),
        )
        .pipe(runtime.outboxLock.withPermits(1));
      if (cancelled.worker) yield* Fiber.interrupt(cancelled.worker);
      if (cancelled.cancelled) yield* changed;
      return cancelled.cancelled;
    });

  const cancelWaitingSend = (id: string) => cancelSendWhere(id, isWaitingSend);

  const cancelQueuedSend = (id: string) => cancelSendWhere(id, (item) => item.status !== "sending");

  const cancelDesktopUndoSends = (owner?: string) =>
    Effect.gen(function* () {
      const canCancel = desktopSendForOwner(owner);
      yield* Effect.forEach(
        (yield* store.queuedSends).filter(canCancel),
        (item) => cancelSendWhere(item.id, canCancel),
        { discard: true },
      );
    });

  const recordSendFailure = (item: QueuedSend, reason: string) =>
    store.recordFailedOp({
      accountId: item.accountId,
      providerId: item.id,
      kind: "send",
      reason,
      subject: item.message.subject,
      sender: item.message.from?.address ?? null,
    });

  const expireDesktopSend = (item: QueuedSend) =>
    Effect.gen(function* () {
      yield* store.putQueuedSend({ ...item, status: "retryable" });
      yield* recordSendFailure(item, "The send window expired. Open the draft and send it again.");
    });

  const deliverQueuedSend = (
    id: string,
    deliveryId?: string,
    canSend: () => boolean = () => true,
  ) =>
    Effect.gen(function* () {
      if (!canSend()) return yield* new InvalidInput({ message: "Queued delivery is paused" });
      const claimed = yield* store
        .transaction(
          Effect.gen(function* () {
            const queued = (yield* store.queuedSends).find((entry) => entry.id === id);
            if (
              queued?.status !== "waiting" ||
              (deliveryId !== undefined && queued.deliveryId !== deliveryId)
            )
              return yield* new InvalidInput({
                message: "The queued send was cancelled or already started",
              });
            if (
              queued.desktopUndo &&
              (yield* Clock.currentTimeMillis) - queued.due > WRITE_RECOVERY_WINDOW_MS
            ) {
              yield* expireDesktopSend(queued);
              return Option.none<QueuedSend>();
            }
            yield* store.putQueuedSend({ ...queued, status: "sending" });
            yield* store.setSendUncertain(queued.id, true);
            return Option.some(queued);
          }),
        )
        .pipe(runtime.outboxLock.withPermits(1));
      if (Option.isNone(claimed)) {
        yield* changed;
        return yield* new InvalidInput({ message: "The send window expired" });
      }
      const item = claimed.value;
      runtime.pendingSends++;
      const delivered = yield* send(
        {
          kind: "send",
          accountId: item.accountId,
          draftId: item.id,
          message: item.message,
          ...(item.archive ? { archive: true } : {}),
        },
        { kind: "user", surface: "app" },
        true,
      ).pipe(
        Effect.result,
        Effect.ensuring(
          Effect.sync(() => {
            runtime.pendingSends--;
          }),
        ),
      );
      if (delivered._tag === "Success") {
        yield* store
          .transaction(
            Effect.gen(function* () {
              const current = (yield* store.queuedSends).find((entry) => entry.id === item.id);
              if (current?.deliveryId !== item.deliveryId || current?.status !== "sending") return;
              yield* (yield* store.sendUncertain(item.id))
                ? store.putQueuedSend({ ...item, status: "failed" })
                : store.deleteQueuedSend(item.id);
            }),
          )
          .pipe(runtime.outboxLock.withPermits(1));
        yield* changed;
        return {
          status: "applied",
          ...(delivered.success ? { flush: delivered.success } : {}),
        } satisfies Outcome;
      }
      const error = delivered.failure;
      const definite = isDefiniteSendFailure(error);
      yield* store
        .transaction(
          Effect.gen(function* () {
            const current = (yield* store.queuedSends).find((entry) => entry.id === item.id);
            if (current?.deliveryId !== item.deliveryId || current?.status !== "sending") return;
            yield* Effect.all([
              store.putQueuedSend({
                ...item,
                status:
                  error._tag === "InvalidInput" || error._tag === "NotFound"
                    ? "rejected"
                    : definite
                      ? "retryable"
                      : "failed",
              }),
              store.setSendUncertain(item.id, !definite),
            ]);
            if (item.desktopUndo) yield* recordSendFailure(item, error.message);
          }),
        )
        .pipe(runtime.outboxLock.withPermits(1));
      yield* changed;
      return yield* Effect.fail(error);
    });

  const scheduleQueuedSend = (id: string, due: number, deliveryId?: string) =>
    Effect.gen(function* () {
      const token = Symbol();
      const registered = yield* Deferred.make<void>();
      const worker = yield* Effect.gen(function* () {
        yield* Deferred.await(registered);
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, due - now));
        return yield* deliverQueuedSend(id, deliveryId);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (runtime.undoSendWorkers.get(id)?.token === token)
              runtime.undoSendWorkers.delete(id);
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(mailboxScope),
      );
      runtime.undoSendWorkers.set(id, { worker, token });
      yield* Deferred.succeed(registered, undefined);
      return worker;
    }).pipe(Effect.uninterruptible);

  const queueUndoSend = (
    input: DraftInput,
    due: number,
    {
      archive = false,
      confirmResend = false,
      owner,
    }: { archive?: boolean; confirmResend?: boolean; owner?: string } = {},
  ) =>
    Effect.gen(function* () {
      yield* queueSend(input, due, confirmResend, {
        desktopUndo: true,
        archive,
        ...(owner === undefined ? {} : { desktopOwner: owner }),
      });
      const item = (yield* store.queuedSends).find((entry) => entry.id === input.id);
      yield* scheduleQueuedSend(input.id, due, item?.deliveryId);
    }).pipe(runtime.outboxLock.withPermits(1));

  const awaitUndoSend = (id: string) =>
    Effect.suspend(() => {
      const worker = runtime.undoSendWorkers.get(id)?.worker;
      return worker
        ? Fiber.join(worker)
        : Effect.fail(new InvalidInput({ message: "No pending undo send was found" }));
    });

  const flushQueuedSends = (canSend: () => boolean = () => true) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (readOnly) return;
      for (const item of yield* store.queuedSends) {
        if (!canSend()) break;
        if (
          item.status !== "waiting" ||
          item.due > now ||
          (item.desktopUndo && !options.resumeDesktopSends)
        )
          continue;
        const account = yield* store.getAccount(item.accountId).pipe(Effect.option);
        if (
          Option.isNone(account) ||
          (item.desktopUndo
            ? attachmentProblem(account.value.provider, item.message.attachments)
            : mobileAttachmentProblem(account.value.provider, item.message.attachments))
        ) {
          yield* store.putQueuedSend({ ...item, status: "rejected" });
          yield* changed;
          continue;
        }
        yield* deliverQueuedSend(item.id, item.deliveryId, canSend).pipe(Effect.result);
        yield* changed;
      }
    });
  const start = Effect.gen(function* () {
    // Recover interrupted claims only in send-owning app layers; CLI/MCP never resume desktop intents.
    if (!readOnly && (options.resumeDesktopSends || options.localDraftQueue)) {
      yield* resumeHeldDiscards;
      for (const item of yield* store.queuedSends) {
        if (item.status === "sending") {
          yield* store.transaction(
            Effect.all([
              store.putQueuedSend({ ...item, status: "failed" }),
              store.setSendUncertain(item.id, true),
            ]),
          );
          if (item.desktopUndo)
            yield* recordSendFailure(
              item,
              "Sending was interrupted. Check Sent before trying again.",
            );
        } else if (options.resumeDesktopSends && item.desktopUndo && item.status === "waiting") {
          yield* (yield* Clock.currentTimeMillis) - item.due > WRITE_RECOVERY_WINDOW_MS
            ? store.transaction(expireDesktopSend(item))
            : scheduleQueuedSend(item.id, item.due, item.deliveryId);
        }
      }
    }
  });
  /**
   * Records the discard, so a save racing it can't bring the draft back, in the
   * same transaction that deletes the queued send and the draft: a crash leaves
   * all of it or none.
   */
  const discardNow = (id: string) =>
    discardDraft(
      id,
      store.markDraftDiscarded(id).pipe(Effect.andThen(store.deleteQueuedSend(id))),
    ).pipe(runtime.outboxLock.withPermits(1));

  /**
   * Discards waiting for their undo window. The draft stays untouched until the worker runs.
   * Each also has a draft_discards row, so a restart inside the window still discards it.
   */
  const heldDiscards = new Map<string, Fiber.Fiber<void>>();
  /** Takes a held discard back; the worker removes its entry before it starts deleting. */
  const releaseDiscard = (id: string) =>
    Effect.gen(function* () {
      const worker = heldDiscards.get(id);
      heldDiscards.delete(id);
      if (worker) yield* Fiber.interrupt(worker);
      const stored = yield* store.releaseDraftDiscard(id);
      return worker !== undefined || stored;
    });

  /** Runs the discard at `at` unless it is taken back first, here or by another process. */
  const holdUntil = (id: string, at: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const worker = yield* Effect.sleep(Math.max(0, at - now)).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (heldDiscards.get(id) !== worker) return;
            heldDiscards.delete(id);
            const held = yield* store.draftDiscard(id);
            if (Option.isNone(held) || held.value.discarded) return;
            yield* discardNow(id);
          }).pipe(Effect.uninterruptible),
        ),
        Effect.forkIn(mailboxScope),
      );
      heldDiscards.set(id, worker);
    });

  const discardDraftLater = (id: string, holdMs: number) =>
    Effect.gen(function* () {
      yield* releaseDiscard(id);
      const draft = yield* store.getDraft(id);
      if (Option.isNone(draft)) return false;
      if (holdMs <= 0 || draft.value.proposalId !== null) {
        yield* discardNow(id);
        return false;
      }
      const at = (yield* Clock.currentTimeMillis) + holdMs;
      yield* store.holdDraftDiscard(id, at);
      yield* holdUntil(id, at);
      return true;
    }).pipe(Effect.uninterruptible);

  /**
   * At start: discards whose window passed while OpenMail was not running happen now, and the
   * rest wait out what is left of theirs. A finished discard whose draft is still there, left
   * by a version that wrote the tombstone apart from the delete, is finished too. Old
   * tombstones go.
   */
  const resumeHeldDiscards = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* store.pruneDraftDiscards(now - DISCARD_TOMBSTONE_MS);
    for (const held of yield* store.draftDiscards) {
      if (heldDiscards.has(held.id)) continue;
      const exists = Option.isSome(yield* store.getDraft(held.id));
      if (held.discarded) {
        if (exists) yield* discardNow(held.id);
      } else if (!exists) yield* store.markDraftDiscarded(held.id);
      else if (held.discardAt <= now) yield* discardNow(held.id);
      else yield* holdUntil(held.id, held.discardAt);
    }
  });

  /** The mailbox is closing: finish the discards the person asked for. */
  const finishHeldDiscards = Effect.suspend(() => {
    const ids = [...heldDiscards.keys()];
    heldDiscards.clear();
    return Effect.forEach(ids, discardNow, { discard: true });
  });

  return {
    send,
    start,
    finishHeldDiscards,
    outbox: {
      queuedSends: store.queuedSends,

      queueSend: (input, due, confirmResend) =>
        queueSend(input, due, confirmResend).pipe(runtime.outboxLock.withPermits(1)),

      queueUndoSend,

      awaitUndoSend,

      cancelWaitingSend,

      cancelQueuedSend,

      cancelDesktopUndoSends,

      flushQueuedSends,

      pendingSendCount: store.queuedSends.pipe(
        Effect.map(
          (items) =>
            runtime.pendingSends +
            items.filter((item) => item.desktopUndo && item.status === "waiting").length,
        ),
      ),
    } satisfies Omit<MailboxOutbox, "sendAgain">,
    // Held discards live here; compose takes these over the drafts part's own.
    compose: {
      discardDraft: (id) => releaseDiscard(id).pipe(Effect.andThen(discardNow(id))),

      discardDraftLater,

      restoreDraft: (id) =>
        Effect.gen(function* () {
          const draft = (yield* releaseDiscard(id)) ? yield* draftStatus(id) : null;
          if (!draft) return yield* new InvalidInput({ message: DISCARDED_DRAFT_MESSAGE });
          return draft;
        }),

      // A save of a draft whose discard is held or done fails (persistDraft); opening it keeps it.
      saveDraft,

      openDraft: (id) => releaseDiscard(id).pipe(Effect.andThen(openDraft(id))),
    } satisfies Pick<
      MailboxCompose,
      "discardDraft" | "discardDraftLater" | "restoreDraft" | "saveDraft" | "openDraft"
    >,
  };
};
