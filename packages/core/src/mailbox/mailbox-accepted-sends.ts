import { Cause, Clock, Effect, Option } from "effect";
import { logWarning, throttledWarning } from "../domain/diagnostic-log.js";
import type { SmtpAcceptedSend, StoredDraft } from "../store/service.js";
import { SMTP_ACCEPTED_CLAIM_RENEW_MS } from "../store/store-smtp-accepted.js";
import type { MailboxDependencies } from "./mailbox-runtime.js";

/** A Sent copy that fails this many times, or for this long, becomes a sentCopyMissing notice. */
const MAX_SENT_COPY_TRIES = 10;
const SENT_COPY_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed filing, a sync retries it 1 h later, then 2 h, 4 h and so on up to a day. */
const FIRST_BACKOFF_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** When a sync may try the record again: right away until a filing has failed. */
export const nextSentCopyTry = (accepted: SmtpAcceptedSend) =>
  accepted.lastTryAt === undefined || accepted.tries === 0
    ? 0
    : accepted.lastTryAt +
      Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(accepted.tries - 1, 16));

/**
 * Keeps `token`'s claim on the record fresh until interrupted. It skips the UPDATE until
 * `recorded()` says the record exists, and a failed renewal only logs: the send it guards must
 * never end because of it.
 */
const renewingClaim = (
  store: MailboxDependencies["store"],
  draftId: string,
  token: string,
  recorded: () => boolean,
) => {
  const warn = throttledWarning("send-claim-renew-failed");
  return Effect.sleep(SMTP_ACCEPTED_CLAIM_RENEW_MS).pipe(
    Effect.andThen(
      Effect.suspend(() => (recorded() ? store.renewSmtpAccepted(draftId, token) : Effect.void)),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : warn("Renewing the claim on an accepted send failed", cause),
    ),
    Effect.forever,
  );
};

/**
 * Runs `effect` while `token` holds the SMTP-accepted record of `draftId`, renewing the claim in
 * a scoped fiber so a sync retry in this or another process leaves the record alone. The renewal
 * cannot end or interrupt `effect`. Pass `recorded` when the record is written partway through
 * `effect`. A send that fails or is interrupted gives the claim back, so the next retry finishes
 * it at once; a crash leaves the claim to expire.
 */
export const holdingAcceptedClaim =
  (
    store: MailboxDependencies["store"],
    draftId: string,
    token: string,
    recorded: () => boolean = () => true,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.andThen(Effect.forkScoped(renewingClaim(store, draftId, token, recorded)), effect),
    ).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success" ? Effect.void : store.releaseSmtpAccepted(draftId, token),
      ),
    );

/**
 * Restart recovery for sends SMTP accepted whose Sent copy is not filed yet. The live send owns
 * its record through a claim; only records no live process holds are finished here.
 */
export const makeAcceptedSends = (
  deps: Pick<MailboxDependencies, "store" | "providers" | "crypto" | "changed" | "readOnly"> & {
    resumes: boolean;
    removeDraft: (draft: StoredDraft) => Effect.Effect<void>;
    settleProposal: (proposalId: number, approve: boolean) => Effect.Effect<void>;
  },
) => {
  const { store, providers, crypto, changed, readOnly, resumes, removeDraft, settleProposal } =
    deps;

  /**
   * SMTP accepted this send, then the send stopped before it finished, or it finished and could
   * not file its Sent copy. The message is out: finish the send as the live path would have, and
   * file its Sent copy. The record stays until the copy is filed (saveSent skips a copy Sent
   * already has by Message-ID), and a later successful sync of the account tries again, backing
   * off by time (nextSentCopyTry). After MAX_SENT_COPY_TRIES failures or SENT_COPY_RETRY_MS the
   * person gets a sentCopyMissing notice instead.
   */
  const finishAcceptedSend = (accepted: SmtpAcceptedSend) =>
    Effect.gen(function* () {
      const token = crypto.randomUUID();
      if (!(yield* store.claimSmtpAccepted(accepted.draftId, token))) return;
      yield* finishClaimed(accepted).pipe(holdingAcceptedClaim(store, accepted.draftId, token));
    });

  /** Ends by deleting the record or, through noteSentCopyFailure, releasing the claim. */
  const finishClaimed = (accepted: SmtpAcceptedSend) =>
    Effect.gen(function* () {
      const { draftId } = accepted;
      const account = yield* store.getAccount(accepted.accountId).pipe(Effect.option);
      const adapter = Option.isSome(account) ? providers.get(account.value.provider) : undefined;
      const filed =
        Option.isSome(account) && adapter?.fileSentCopy
          ? yield* adapter.fileSentCopy(account.value, accepted.raw).pipe(Effect.result)
          : undefined;
      const queued = (yield* store.queuedSends).find((item) => item.id === draftId);
      const draft = yield* store.getDraft(draftId);
      const message = queued?.message ?? (Option.isSome(draft) ? draft.value.message : undefined);
      const subject = accepted.subject ?? message?.subject ?? "";
      const sender =
        accepted.sender ??
        message?.from?.address ??
        (Option.isSome(account) ? account.value.email : "");
      const now = yield* Clock.currentTimeMillis;
      const failed = filed?._tag === "Failure";
      const giveUp =
        failed &&
        (accepted.tries + 1 >= MAX_SENT_COPY_TRIES || now - accepted.at >= SENT_COPY_RETRY_MS);
      yield* store.transaction(
        Effect.gen(function* () {
          if (Option.isSome(draft)) yield* removeDraft(draft.value);
          yield* store.deleteQueuedSend(draftId);
          yield* store.setSendUncertain(draftId, false);
          yield* store.setSendPreparationState(draftId, null);
          yield* failed && !giveUp
            ? store.noteSentCopyFailure(draftId, { subject, sender })
            : store.clearSmtpAccepted(draftId);
        }),
      );
      if (Option.isSome(draft) && draft.value.proposalId !== null)
        yield* settleProposal(draft.value.proposalId, true);
      if (giveUp)
        yield* store.recordFailedOp({
          accountId: accepted.accountId,
          providerId: draftId,
          kind: "sentCopyMissing",
          reason: `SMTP accepted the message, but saving its Sent copy failed: ${filed.failure.message}`,
          subject,
          sender,
        });
      yield* changed;
    });

  /**
   * Sent copies still missing after SMTP accepted the send. A successful sync retries those whose
   * backoff has passed; the launch retry (`waitForBackoff` false) tries every one.
   */
  const retryAcceptedSends = (accountId?: string, waitForBackoff = true) =>
    Effect.gen(function* () {
      if (readOnly || !resumes) return;
      const now = yield* Clock.currentTimeMillis;
      const accepted = (yield* store.smtpAccepted).filter(
        (entry) =>
          (accountId === undefined || entry.accountId === accountId) &&
          (!waitForBackoff || nextSentCopyTry(entry) <= now),
      );
      yield* Effect.forEach(accepted, finishAcceptedSend, { discard: true });
    }).pipe(
      Effect.catchCause((cause) =>
        logWarning("sent-copy-failed", "Finishing an accepted send failed", cause),
      ),
    );

  return { retryAcceptedSends };
};
