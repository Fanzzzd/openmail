import { Clock, Effect, Option } from "effect";
import { logWarning } from "../domain/diagnostic-log.js";
import {
  attachmentProblem,
  attachmentProblemMessage,
  attachmentSizesProblem,
  COMPOSE_ATTACHMENT_LIMIT,
  GMAIL_MIME_LIMIT,
} from "../mime/attachment-policy.js";
import {
  normalizeComposeMessage,
  preservedComposeHtml,
  withQuotedComposeHtml,
  remoteComposeBody,
} from "../compose/compose-body.js";
import type { Account } from "../domain/account.js";
import { actorLabel } from "../domain/command.js";
import type { DraftInput, OutgoingMessage } from "../domain/changes.js";
import type { Message } from "../domain/message.js";
import { draftVersionMetadata } from "../compose/draft-version.js";
import {
  attachmentsKey,
  draftOrganizationKey,
  importedMessage,
  originalAttachment,
  type ParsedDraft,
  toDraft,
  withDraftMarkdownSource,
} from "../compose/drafts.js";
import {
  DraftConflict,
  InvalidInput,
  NotFound,
  PermanentError,
  ProviderError,
} from "../domain/errors.js";
import { isLocalFeedbackDraft } from "../app/feedback.js";
import { withAgentOrigin } from "./mailbox-apply.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { DISCARDED_DRAFT_MESSAGE, WRITE_RECOVERY_WINDOW_MS } from "./mailbox-shared.js";
import type { MailboxCompose, MailboxOutbox } from "./mailbox.js";
import { renderMarkdown } from "../compose/markdown.js";
import { newMessageId } from "../mime/message-id.js";
import { PlatformCrypto } from "../platform/crypto.js";
import type { ProviderPushContext } from "../providers/adapter.js";
import type { StoredDraft } from "../store/service.js";
import { providerCapabilities } from "../providers/capabilities.js";
import { sendOriginal } from "../providers/send-original.js";

export const makeDraftsMailbox = (
  deps: MailboxDependencies & { flushLater: Effect.Effect<void | boolean> },
  _runtime: MailboxRuntimeState,
) => {
  const { store, providers, crypto, changed, flushLater, parseRawDraft, newDraftId } = deps;

  /**
   * A message ready for the provider: Markdown rendered, and for a forward
   * as attachment the original fetched as an .eml and the message turned
   * into a new one. `original` is what replies and forwards thread on.
   */
  const prepare = Effect.fnUntraced(function* (message: OutgoingMessage) {
    const normalized = normalizeComposeMessage(message);
    const prepared: OutgoingMessage = normalized.markdown
      ? { ...normalized, html: renderMarkdown(normalized.text) }
      : normalized;
    // Source stays in local metadata; transport uses its own wider safe allow-list.
    const out: OutgoingMessage = withQuotedComposeHtml(
      prepared.originalHtml === undefined
        ? prepared
        : { ...prepared, html: preservedComposeHtml(prepared.originalHtml) },
    );
    if (!message.inReplyTo) return { message: out, original: Option.none() };
    const ref = yield* store.messageRef(message.inReplyTo);
    const source = yield* store.getMessage(message.inReplyTo);
    if (!message.forwardAsAttachment) {
      return {
        message: out,
        original: Option.some(sendOriginal(ref.providerId, source)),
      };
    }
    // The original lives on the account that received it.
    const owner = yield* store.getAccount(ref.accountId);
    const raw = yield* providers.get(owner.provider).fetchRaw(owner, ref.providerId);
    const forwarded: OutgoingMessage = {
      to: out.to,
      cc: out.cc,
      bcc: out.bcc,
      subject: out.subject,
      text: out.text,
      ...(out.html === undefined ? {} : { html: out.html }),
      ...(out.markdown ? { markdown: true } : {}),
      attachments: [...out.attachments, originalAttachment(source.subject, raw)],
      mode: "new",
      ...(out.from ? { from: out.from } : {}),
    };
    return { message: forwarded, original: Option.none() };
  });

  /** Pushes a draft's current content. A draft discarded meanwhile loses its new copy too. */
  const pushDraft = Effect.fnUntraced(function* (
    account: Account,
    draftId: string,
    claim?: { readonly id: number; readonly token: string },
    context?: ProviderPushContext,
  ) {
    const stored = yield* store.getDraft(draftId);
    // Discarded, or moved to another account (a newer op pushes it there).
    if (Option.isNone(stored) || stored.value.accountId !== account.id || stored.value.localOnly) {
      // An earlier attempt of this op APPENDed a copy and then died before recording it.
      // Discard skipped the op while it was claimed, so this attempt removes that copy.
      const orphan = context?.appendedDraftMessageId;
      if (orphan) {
        const remote = { draftId: null, messageId: null, rfcMessageId: orphan };
        yield* providers
          .get(account.provider)
          .deleteDraft(account, remote)
          .pipe(
            Effect.catch(() =>
              store.enqueueOp(account.id, draftId, { kind: "deleteDraft", remote }),
            ),
          );
      }
      return;
    }
    const draft = stored.value;
    const adapter = providers.get(account.provider);
    const { message, original } = yield* prepare(draft.message).pipe(
      Effect.catchTag("NotFound", (e) =>
        Effect.fail(new PermanentError({ message: `The original ${e.what} is gone` })),
      ),
    );
    const key =
      attachmentsKey(message.attachments) +
      (message.includeOriginalAttachments === undefined
        ? ""
        : `|original:${message.includeOriginalAttachments}`);
    const organizationKey = draftOrganizationKey(message.draftOrganization);
    const organizationChanged =
      organizationKey !== null && organizationKey !== draft.pushedOrganization;
    const { draftOrganization, ...bodyMessage } = message;
    const withDraftClaim = <A>(effect: Effect.Effect<A>) =>
      store.transaction(
        Effect.gen(function* () {
          if (claim && !(yield* store.ownsPendingOp(claim.id, claim.token)))
            return yield* new ProviderError({
              message: "The queued draft is no longer owned by this worker",
              deferred: true,
            });
          return yield* effect;
        }),
      );
    const remote = yield* adapter.saveDraft(
      account,
      {
        creation: {
          begin: () =>
            withDraftClaim(
              Effect.gen(function* () {
                const creationState = yield* store.draftCreateState(draftId);
                if (Option.isSome(creationState)) return creationState.value;
                const sender = message.from?.address ?? account.email;
                const next = {
                  messageId: yield* newMessageId(sender).pipe(
                    Effect.provideService(PlatformCrypto, crypto),
                  ),
                  attempted: false,
                };
                yield* store.setDraftCreateState(draftId, next);
                return next;
              }),
            ),
          attempted: (messageId, attempted = true) =>
            withDraftClaim(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                yield* store.setDraftCreateState(draftId, {
                  messageId,
                  attempted,
                  attemptedAt: now,
                  emptyLookups: 0,
                });
              }),
            ),
          missing: () =>
            withDraftClaim(
              Effect.gen(function* () {
                const creationState = yield* store.draftCreateState(draftId);
                if (Option.isNone(creationState)) return true;
                const now = yield* Clock.currentTimeMillis;
                const attemptedAt = creationState.value.attemptedAt ?? now;
                const emptyLookups = (creationState.value.emptyLookups ?? 0) + 1;
                const retry = emptyLookups >= 3 && now - attemptedAt >= WRITE_RECOVERY_WINDOW_MS;
                yield* store.setDraftCreateState(draftId, {
                  ...creationState.value,
                  attemptedAt,
                  emptyLookups,
                  attempted: !retry,
                });
                return retry;
              }),
            ),
          remember: (created) =>
            Effect.gen(function* () {
              if (!(yield* store.setDraftRemote(draftId, created, null, account.id, claim))) {
                const latest = yield* store.getDraft(draftId);
                if (
                  created.messageId !== draft.remote?.messageId &&
                  created.messageId !==
                    (Option.isSome(latest) ? latest.value.remote?.messageId : undefined)
                )
                  yield* store.enqueueOp(account.id, draftId, {
                    kind: "deleteDraft",
                    remote: created,
                  });
              }
            }),
        },
        remote: draft.remote,
        writing: (nonce) => withDraftClaim(store.setDraftWriteNonce(draftId, nonce)),
        message:
          organizationChanged && providerCapabilities(account.provider).organization === "folders"
            ? message
            : bodyMessage,
        original,
        replaceAttachments: key !== draft.pushedAttachments,
      },
      context,
    );
    if (
      !(yield* store.setDraftRemote(
        draftId,
        remote,
        remote.saveError ? null : key,
        account.id,
        claim,
      ))
    ) {
      if (claim && !(yield* store.ownsPendingOp(claim.id, claim.token))) {
        const latest = yield* store.getDraft(draftId);
        if (
          remote.messageId === (Option.isSome(latest) ? latest.value.remote?.messageId : undefined)
        )
          return;
        if (remote.messageId === draft.remote?.messageId) return;
      }
      yield* adapter
        .deleteDraft(account, remote)
        .pipe(
          Effect.catch(() => store.enqueueOp(account.id, draftId, { kind: "deleteDraft", remote })),
        );
      return;
    }
    const cleanupIds = new Set([
      ...(remote.cleanupMessageIds ?? []),
      ...(remote.cleanupMessageId ? [remote.cleanupMessageId] : []),
    ]);
    for (const messageId of cleanupIds)
      yield* store.enqueueOp(account.id, draftId, {
        kind: "deleteDraft",
        remote: { draftId: messageId, messageId },
      });
    yield* store.setDraftCreateState(draftId, null);
    if (remote.replacedMessageId)
      yield* store.enqueueOp(account.id, remote.replacedMessageId, {
        kind: "deleteDraft",
        remote: { draftId: remote.replacedMessageId, messageId: remote.replacedMessageId },
      });
    if (remote.saveError) yield* Effect.fail(remote.saveError);
    const old = remote.conflict ? null : draft.remote?.messageId;
    if (old && old !== remote.messageId) yield* store.deleteMessage(account.id, old);
    let organizationApplied = organizationChanged;
    if (
      organizationChanged &&
      remote.messageId &&
      draftOrganization &&
      providerCapabilities(account.provider).organization === "folders" &&
      adapter.setDraftOrganization
    ) {
      organizationApplied = yield* adapter
        .setDraftOrganization(account, remote.messageId, draftOrganization)
        .pipe(
          Effect.as(true),
          Effect.catchCause(() =>
            logWarning(
              "draft-organization-failed",
              "Draft organization could not be applied; body saved",
            ).pipe(Effect.as(false)),
          ),
        );
    }
    if (organizationChanged && organizationApplied && remote.messageId && adapter.draftVersion) {
      const version = yield* adapter.draftVersion(account, remote.messageId).pipe(Effect.option);
      if (Option.isSome(version))
        yield* store.setDraftRemote(
          draftId,
          {
            ...remote,
            ...draftVersionMetadata(version.value),
          },
          key,
          account.id,
          claim,
        );
    }
    if (remote.conflict) {
      yield* store.setDraftSyncError(
        draftId,
        "The remote draft changed in another client. Both versions were kept.",
      );
      yield* store.appendAudit({
        actor: { kind: "user", surface: "app" },
        accountId: account.id,
        action: "draft-conflict",
        detail: { draftId, previous: draft.remote, remote },
      });
    }
    // A label failure must not replay a successful MIME save through the op queue.
    // Record the attempted intent as well: a new UI change gets a new key.
    if (organizationChanged) yield* store.setDraftOrganizationKey(draftId, organizationKey);
    if (old !== remote.messageId || organizationApplied) yield* changed;
  });

  /** Settles an agent's message proposal once the person sent or discarded its draft. */
  const settleProposal = Effect.fnUntraced(function* (proposalId: number, approve: boolean) {
    const proposal = yield* store.getProposal(proposalId).pipe(Effect.option);
    if (Option.isNone(proposal) || proposal.value.status !== "pending") return;
    yield* store.setProposalStatus(proposalId, approve ? "approved" : "rejected");
    yield* store.appendAudit({
      actor: { kind: "user", surface: "app" },
      action: approve ? "approve" : "reject",
      detail: { proposalId, proposer: actorLabel(proposal.value.actor) },
    });
  });

  /** Deletes a draft here and queues deleting the provider's copy. */
  const removeDraft = Effect.fnUntraced(function* (draft: StoredDraft) {
    yield* store.deleteDraft(draft.id);
    const { remote } = draft;
    if (!remote) return;
    yield* store.enqueueOp(draft.accountId, remote.messageId ?? remote.draftId ?? draft.id, {
      kind: "deleteDraft",
      remote,
    });
    if (remote.messageId) yield* store.deleteMessage(draft.accountId, remote.messageId);
  });

  // Drafts

  const publicDraft = Effect.fnUntraced(function* (draft: StoredDraft) {
    const saveStatus = yield* store.draftSaveState(draft.id);
    return { ...toDraft(draft, saveStatus.pending), syncRetrying: saveStatus.retrying };
  });

  const draftStatus = (id: string) =>
    Effect.gen(function* () {
      const draft = yield* store.getDraft(id);
      return Option.isSome(draft) ? yield* publicDraft(draft.value) : null;
    });

  const persistDraft = Effect.fnUntraced(function* (input: DraftInput, enqueue: boolean) {
    const account = yield* store.getAccount(input.accountId);
    const draftOrganizationInput = input.message.draftOrganization;
    if (
      draftOrganizationInput?.labels.some(
        (label) =>
          !label.trim() ||
          label.includes("\r") ||
          label.includes("\n") ||
          label.includes("\0") ||
          (account.provider === "gmail" && !label.startsWith("Label_")) ||
          (account.provider === "imap" && !/^[a-zA-Z0-9_$.-]+$/.test(label)),
      )
    )
      return yield* new InvalidInput({ message: "Invalid draft label or keyword" });
    const saved = yield* store.transaction(
      Effect.gen(function* () {
        // A save that arrives after the person discarded the draft must not bring it back.
        const discard = yield* store.draftDiscard(input.id);
        if (Option.isSome(discard))
          return yield* new InvalidInput({
            message: discard.value.discarded
              ? DISCARDED_DRAFT_MESSAGE
              : "This draft is being discarded. Undo the discard to keep it.",
          });
        const existing = yield* store.getDraft(input.id);
        // Another editor, the phone or an agent saved after this editor loaded the draft.
        // Its own earlier saves may still be arriving, so they never count as a conflict.
        if (
          Option.isSome(existing) &&
          input.expectedRevision !== undefined &&
          existing.value.revision !== input.expectedRevision &&
          (input.editor === undefined || existing.value.editor !== input.editor)
        )
          return yield* new DraftConflict({ id: input.id, revision: existing.value.revision });
        const localOnly = Option.isSome(existing) && existing.value.localOnly;
        if (Option.isSome(existing)) {
          const old = existing.value;
          // Detach a local copy from its old mirror; synced drafts remove that mirror.
          if (old.accountId !== input.accountId && old.remote) {
            // The earlier send may still arrive, so the resend guard outlives the switch.
            const uncertain = yield* store.sendUncertain(old.id);
            yield* localOnly ? store.deleteDraft(old.id) : removeDraft(old);
            if (uncertain) yield* store.setSendUncertain(old.id, true);
          }
        } else {
          yield* store.appendAudit({
            actor: { kind: "user", surface: "app" },
            accountId: input.accountId,
            action: "draft",
            detail: { draftId: input.id, subject: input.message.subject },
          });
        }
        const draft = yield* store.putDraft({
          id: input.id,
          accountId: input.accountId,
          editor: input.editor ?? null,
          message: normalizeComposeMessage({
            ...input.message,
            ...(Option.isSome(existing) && existing.value.message.agentOrigin
              ? { agentOrigin: existing.value.message.agentOrigin }
              : {}),
          }),
        });
        const restoreLocalOnly = localOnly && !draft.localOnly;
        if (restoreLocalOnly) yield* store.setDraftLocalOnly(input.id, true);
        if (enqueue && !isLocalFeedbackDraft(input.id))
          yield* store.enqueueDraftSave(input.accountId, input.id);
        return restoreLocalOnly ? { ...draft, localOnly: true, syncError: null } : draft;
      }),
    );
    return saved;
  });

  const saveDraft = Effect.fn("Mailbox.saveDraft")(function* (input: DraftInput) {
    const saved = yield* persistDraft(input, true);
    yield* changed;
    yield* flushLater;
    return yield* publicDraft(Option.getOrElse(yield* store.getDraft(input.id), () => saved));
  });

  const recoverDraft = Effect.fn("Mailbox.recoverDraft")(function* (
    id: string,
    action: "retry" | "local",
    latest?: DraftInput,
  ) {
    if (latest && latest.id !== id)
      return yield* new InvalidInput({ message: "Recovery draft id does not match" });
    const draft = yield* store.transaction(
      Effect.gen(function* () {
        const stored = yield* store.getDraft(id);
        if (Option.isNone(stored)) return yield* new NotFound({ what: "draft", id });
        const saved = latest ? yield* persistDraft(latest, false) : stored.value;
        yield* store.setDraftLocalOnly(id, action === "local");
        if (action === "retry") yield* store.enqueueDraftSave(saved.accountId, id);
        return saved;
      }),
    );
    if (action === "retry") {
      const account = yield* store.getAccount(draft.accountId);
      if (account.needsReauth || account.enabled === false)
        yield* store.setDraftSyncError(
          id,
          draft.syncError ??
            (account.needsReauth
              ? "Sign in again to sync this draft"
              : "Enable the account to sync this draft"),
        );
      yield* flushLater;
    }
    yield* changed;
    return yield* publicDraft(Option.getOrElse(yield* store.getDraft(id), () => draft));
  });

  /**
   * Deletes the draft and queues its provider delete. `alongside` runs first in
   * the same transaction, so the outbox's tombstone and queued-send delete
   * land together with the draft delete or not at all.
   */
  const discardDraft = Effect.fn("Mailbox.discardDraft")(function* (
    id: string,
    alongside: Effect.Effect<void> = Effect.void,
  ) {
    const draft = yield* store.transaction(
      Effect.gen(function* () {
        yield* alongside;
        const stored = yield* store.getDraft(id);
        if (Option.isNone(stored)) return stored;
        yield* removeDraft(stored.value);
        yield* store.appendAudit({
          actor: { kind: "user", surface: "app" },
          accountId: stored.value.accountId,
          action: "discard_draft",
          detail: { draftId: id, subject: stored.value.message.subject },
        });
        return stored;
      }),
    );
    if (Option.isNone(draft)) return;
    if (draft.value.proposalId !== null) yield* settleProposal(draft.value.proposalId, false);
    yield* flushLater;
    yield* changed;
  });

  /** A draft message from the Drafts list that openmail has no local draft for yet. */
  const importDraft = Effect.fnUntraced(function* (message: Message) {
    const { providerId } = yield* store.messageRef(message.id);
    const account = yield* store.getAccount(message.accountId);
    const fallback: ParsedDraft = {
      to: [...message.to],
      cc: [...message.cc],
      bcc: [],
      subject: message.subject,
      ...(message.bodyHtml ? remoteComposeBody(message.bodyHtml) : { text: message.bodyText }),
      attachments: [],
      isReply: false,
    };
    const adapter = providers.get(account.provider);
    const decoded = yield* adapter.fetchRaw(account, providerId).pipe(
      Effect.flatMap(parseRawDraft),
      Effect.map((parsed) => ({ parsed, fetched: true })),
      // Offline: without attachments the stored copy has everything.
      Effect.catch((error) =>
        message.attachments.length > 0
          ? Effect.fail(error)
          : Effect.succeed({ parsed: fallback, fetched: false }),
      ),
    );
    const markdownSource =
      decoded.fetched && adapter.draftMarkdownSource
        ? yield* adapter
            .draftMarkdownSource(account, providerId)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined;
    const parsed = withDraftMarkdownSource(decoded.parsed, markdownSource);
    const fetchedOrganization = adapter.getDraftOrganization
      ? yield* adapter
          .getDraftOrganization(account, providerId)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined;
    const draftOrganization =
      fetchedOrganization ??
      (providerCapabilities(account.provider).organization === "labels"
        ? {
            labels: message.labels.filter((label) => label.startsWith("Label_")),
            starred: message.isStarred,
          }
        : undefined);
    const thread = yield* store.getThread(message.id);
    const version = adapter.draftVersion
      ? yield* adapter
          .draftVersion(account, providerId)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined;
    return yield* store.transaction(
      Effect.gen(function* () {
        const draft = yield* store.putDraft({
          id: newDraftId(),
          accountId: account.id,
          message: {
            ...importedMessage(parsed, thread),
            ...(draftOrganization ? { draftOrganization } : {}),
          },
        });
        yield* store.setDraftRemote(
          draft.id,
          // Gmail's draft id is looked up by message id when first needed.
          {
            draftId: account.provider === "gmail" ? null : providerId,
            messageId: providerId,
            ...(version ? draftVersionMetadata(version) : {}),
          },
          attachmentsKey(parsed.attachments),
        );
        yield* store.setDraftOrganizationKey(draft.id, draftOrganizationKey(draftOrganization));
        return yield* store.getDraft(draft.id).pipe(Effect.map(Option.getOrThrow));
      }),
    );
  });

  const openDraft = Effect.fn("Mailbox.openDraft")(function* (id: string) {
    const proposalRef = /^proposal:(\d+)$/.exec(id);
    if (proposalRef) {
      const proposalId = Number(proposalRef[1]);
      const linked = yield* store.draftByProposal(proposalId);
      if (Option.isSome(linked)) return yield* publicDraft(linked.value);
      // A proposal from before drafts were synced: it becomes one now.
      const proposal = yield* store.getProposal(proposalId);
      const { command } = proposal;
      if (command.kind !== "send" && command.kind !== "draft") {
        return yield* new InvalidInput({ message: `Proposal ${proposalId} is not a message.` });
      }
      const draft = yield* store.putDraft({
        id: newDraftId(),
        accountId: command.accountId,
        message: withAgentOrigin(command.message, proposal.actor),
        proposalId,
      });
      yield* store.enqueueDraftSave(draft.accountId, draft.id);
      return yield* publicDraft(draft);
    }
    const local = yield* store.getDraft(id);
    if (Option.isSome(local)) return yield* publicDraft(local.value);
    if (id.startsWith("draft:")) return yield* new NotFound({ what: "draft", id });
    const message = yield* store.getMessage(id);
    const { providerId } = yield* store.messageRef(id);
    const linked = yield* store.draftByRemoteMessage(message.accountId, providerId);
    if (Option.isSome(linked)) return yield* publicDraft(linked.value);
    if (!message.labels.includes("DRAFT")) {
      return yield* new InvalidInput({ message: "This message is not a draft." });
    }
    const imported = yield* publicDraft(yield* importDraft(message));
    yield* changed;
    return imported;
  });

  const composeAttachments = Effect.fn("Mailbox.composeAttachments")(function* (id: string) {
    const ref = yield* store.messageRef(id);
    const account = yield* store.getAccount(ref.accountId);
    const source = yield* store.getMessage(id);
    const problem = attachmentSizesProblem(account.provider, source.attachments);
    if (problem) return yield* new InvalidInput({ message: attachmentProblemMessage(problem) });
    if (source.attachments.reduce((total, file) => total + file.size, 0) > COMPOSE_ATTACHMENT_LIMIT)
      return yield* new InvalidInput({
        message: "Original attachments exceed the 30 MB compose limit.",
      });
    const maxBytes =
      account.provider === "gmail"
        ? GMAIL_MIME_LIMIT
        : account.provider === "outlook"
          ? 4 * 1024 * 1024
          : 42 * 1024 * 1024;
    const parsed = yield* providers
      .get(account.provider)
      .fetchRaw(account, ref.providerId, maxBytes)
      .pipe(
        Effect.flatMap((raw) =>
          raw.byteLength > maxBytes
            ? Effect.fail(
                new InvalidInput({
                  message: "Original message exceeds the compose size limit.",
                }),
              )
            : Effect.succeed(raw),
        ),
      )
      .pipe(Effect.flatMap(parseRawDraft));
    const actual = attachmentProblem(account.provider, parsed.attachments);
    if (actual) return yield* new InvalidInput({ message: attachmentProblemMessage(actual) });
    return parsed.attachments.map((attachment) => ({ ...attachment, sourceMessageId: id }));
  });

  const sendAgain = Effect.fn("Mailbox.sendAgain")(function* (id: string) {
    const message = yield* store.getMessage(id);
    if (!message.labels.includes("SENT"))
      return yield* new InvalidInput({ message: "Choose a sent message to send again." });
    const account = yield* store.getAccount(message.accountId);
    const { providerId } = yield* store.messageRef(id);
    const parsed = yield* providers
      .get(account.provider)
      .fetchRaw(account, providerId)
      .pipe(Effect.flatMap(parseRawDraft));
    return yield* saveDraft({
      id: newDraftId(),
      accountId: account.id,
      message: normalizeComposeMessage({
        from: message.from,
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        subject: parsed.subject,
        text: parsed.text,
        ...(parsed.html === undefined ? {} : { html: parsed.html }),
        ...(parsed.originalHtml === undefined ? {} : { originalHtml: parsed.originalHtml }),
        ...(parsed.markdown ? { markdown: true } : {}),
        attachments: parsed.attachments,
        mode: "new",
      }),
    });
  });
  return {
    prepare,
    pushDraft,
    settleProposal,
    removeDraft,
    persistDraft,
    discardDraft,
    outbox: { sendAgain } satisfies Pick<MailboxOutbox, "sendAgain">,
    compose: {
      prepareRejectedResend: (noticeId) =>
        Effect.gen(function* () {
          const { notice, rejected } = yield* store.getFailedOp(noticeId);
          if (notice.kind !== "sendPartial" || !rejected.length)
            return yield* new InvalidInput({
              message: "This notice has no rejected recipients.",
            });
          const draft = yield* store.getDraft(notice.providerId);
          if (Option.isNone(draft))
            return yield* new NotFound({ what: "draft", id: notice.providerId });
          if (draft.value.accountId !== notice.accountId)
            return yield* new InvalidInput({
              message: "This draft changed accounts. Open it to choose recipients.",
            });
          const addresses = new Set(rejected.map((address) => address.trim().toLowerCase()));
          const keep = (recipients: OutgoingMessage["to"]) =>
            recipients.filter((recipient) => addresses.has(recipient.address.toLowerCase()));
          const message = {
            ...draft.value.message,
            to: keep(draft.value.message.to),
            cc: keep(draft.value.message.cc),
            bcc: keep(draft.value.message.bcc),
          };
          if (!message.to.length && !message.cc.length && !message.bcc.length)
            return yield* new InvalidInput({
              message: "The rejected recipients are no longer in this draft.",
            });
          const input = {
            id: `draft:${crypto.randomUUID()}`,
            accountId: notice.accountId,
            message,
          };
          yield* store.putDraft(input);
          yield* changed;
          return input;
        }),

      openDraft,

      draftStatus,

      composeAttachments,

      saveDraft,

      recoverDraft,
    } satisfies Pick<
      MailboxCompose,
      | "prepareRejectedResend"
      | "openDraft"
      | "draftStatus"
      | "composeAttachments"
      | "saveDraft"
      | "recoverDraft"
    >,
  };
};
