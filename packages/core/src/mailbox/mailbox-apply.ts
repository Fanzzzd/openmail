import { Clock, Effect, Option } from "effect";
import { logWarning } from "../domain/diagnostic-log.js";
import { inspectAttachment } from "../mime/attachment-import.js";
import {
  actorLabel,
  type Actor,
  type Command,
  type FlushResult,
  type Outcome,
} from "../domain/command.js";
import type { Account } from "../domain/account.js";
import type { MailOp, OutgoingMessage } from "../domain/changes.js";
import { InvalidInput, type ProviderError } from "../domain/errors.js";
import { decodeProviderId } from "../providers/imap/imap-cursor.js";
import { requireFocusedInboxScope } from "../providers/scoped-adapter.js";
import { applyOpToLabels, folderTarget, invalidCategoryFolderOp } from "../domain/mail-ops.js";
import { type makeBatchMailbox } from "./mailbox-batch.js";
import { eventFromInvite } from "./mailbox-features.js";
import { type makeOrganizationMailbox } from "./mailbox-organization.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { cacheIO, withPendingOps } from "./mailbox-shared.js";
import { type Mailbox, type PerformError } from "./mailbox.js";
import { sha256Hex } from "../platform/crypto.js";
import { decide } from "./policy.js";
import { READ_ONLY_MESSAGE } from "./read-only.js";
import type { Change } from "../providers/adapter.js";
import type { StoredDraft } from "../store/service.js";
import { notificationEligible, profileNotificationsActive } from "../app/system.js";
import { providerCapabilities, supportsOp } from "../providers/capabilities.js";

const isAiProposalActor = (actor: Actor): boolean =>
  actor.kind === "agent" &&
  (actor.surface === "mcp" || actor.surface === "assistant" || actor.name === "openmail-assistant");

/** Where proposals are approved. The CLI and MCP only list and reject them. */
export const APPROVE_IN_APP =
  "Approve proposals in OpenMail, under AI suggestions. The CLI and MCP cannot approve them.";

export const withAgentOrigin = (message: OutgoingMessage, actor: Actor): OutgoingMessage =>
  isAiProposalActor(actor)
    ? {
        ...message,
        agentOrigin: {
          recipients: [...message.to, ...message.cc, ...message.bcc].map((a) => a.address),
          ...(message.inReplyTo ? { replyTo: message.inReplyTo } : {}),
        },
      }
    : message;

const isSpecialAgentLabel = (value: string) => {
  const name = value
    .trim()
    .replace(/[\s_\-\\]/g, "")
    .toUpperCase();
  return (
    /^(INBOX|TRASH|SPAM|DRAFTS?|SENT|JUNK(EMAIL)?|DELETED(ITEMS|MESSAGES)?|ARCHIVE|OUTBOX|ALLMAIL|IMPORTANT|STARRED|UNREAD)$/.test(
      name,
    ) ||
    /^CATEGORY(PERSONAL|SOCIAL|PROMOTIONS|UPDATES|FORUMS)$/.test(name) ||
    value.startsWith("category:") ||
    value.startsWith("mailbox:")
  );
};

export const makeApplyMailbox = (
  deps: MailboxDependencies & {
    flush: (accountIds?: readonly string[], skipImap?: boolean) => Effect.Effect<FlushResult>;
    organization: () => ReturnType<typeof makeOrganizationMailbox>;
    send: (
      command: Extract<Command, { kind: "send" }>,
      actor: Actor,
      claimedSend?: boolean,
    ) => Effect.Effect<FlushResult | undefined, PerformError>;
    removeDraft: (draft: StoredDraft) => Effect.Effect<void>;
    flushLater: Effect.Effect<void | boolean>;
    batchMailbox: () => Effect.Success<ReturnType<typeof makeBatchMailbox>>;
  },
  runtime: MailboxRuntimeState,
) => {
  const {
    store,
    changed,
    flush,
    send,
    diskAttachments,
    providers,
    secrets,
    newDraftId,
    removeDraft,
    flushLater,
    emit,
    readOnly,
    unsubscribeNetwork,
    mutate,
  } = deps;

  // Running commands

  const modify = Effect.fn("Mailbox.modify")(function* (
    command: Extract<Command, { kind: "modify" }>,
    actor: Actor,
  ) {
    if (invalidCategoryFolderOp(command.op))
      return yield* new InvalidInput({
        message: "Categories cannot be used as folders. Use the categories action.",
      });
    const ids = new Set<string>();
    for (const thread of command.threads) {
      for (const id of yield* store.threadMessageIds(thread)) ids.add(id);
    }
    if (ids.size === 0) {
      return yield* new InvalidInput({ message: "No message matches the given thread ids." });
    }
    const refs = yield* Effect.forEach([...ids], (id) =>
      store.messageRef(id).pipe(Effect.map((ref) => ({ id, ...ref }))),
    );
    const accounts = new Map<string, Account>();
    if (command.op.kind === "copy" || command.op.kind === "classification") {
      // Validate every account before queuing anything for mixed selections.
      for (const { accountId } of refs) {
        if (accounts.has(accountId)) continue;
        const account = yield* store.getAccount(accountId);
        if (!supportsOp(providerCapabilities(account.provider), command.op.kind))
          return yield* new InvalidInput({
            message: "This organization action is unavailable for this account.",
          });
        if (command.op.kind === "classification")
          yield* requireFocusedInboxScope(store, account.id);
        accounts.set(accountId, account);
      }
    }
    for (const { id, accountId, providerId } of refs) {
      let account = accounts.get(accountId);
      if (!account) {
        account = yield* store.getAccount(accountId);
        accounts.set(accountId, account);
      }
      // IMAP importance is read-only; removing an absent folder does nothing.
      const flag =
        command.op.kind === "classification" ||
        command.op.kind === "read" ||
        command.op.kind === "star" ||
        (command.op.kind === "important" && providerCapabilities(account.provider).important);
      if (providerCapabilities(account.provider).organization === "folders" && !flag) {
        const labels = yield* store.messageLabels(accountId, providerId);
        if (command.op.kind !== "copy" && !folderTarget(command.op, labels)) continue;
      }
      yield* store.transaction(
        Effect.all([
          store.applyLocalOp(id, command.op),
          store.enqueueOp(accountId, providerId, command.op),
          store.appendAudit({
            actor,
            accountId,
            action: command.op.kind,
            detail: { id, op: command.op },
          }),
        ]),
      );
    }
    yield* changed;
    // Local state already changed; a failed push stays queued for the next sync.
    const result = yield* flush();
    if (result.reauth.length) yield* changed;
    return result;
  });

  const run = Effect.fn("Mailbox.run")(function* (command: Command, actor: Actor) {
    switch (command.kind) {
      case "modify":
        return { status: "applied", flush: yield* modify(command, actor) } satisfies Outcome;
      case "snooze":
        yield* deps.organization().snooze(command.threads, command.due);
        return { status: "applied" } satisfies Outcome;
      case "send": {
        const flushed = yield* Effect.sync(() => {
          runtime.pendingSends++;
        }).pipe(
          Effect.andThen(send(command, actor)),
          Effect.ensuring(
            Effect.sync(() => {
              runtime.pendingSends--;
            }),
          ),
        );
        return (
          flushed ? { status: "applied", flush: flushed } : { status: "applied" }
        ) satisfies Outcome;
      }
      case "removeAccount":
        yield* store.getAccount(command.accountId);
        for (const item of yield* store.queuedSends)
          if (item.accountId === command.accountId) yield* store.deleteQueuedSend(item.id);
        runtime.attachmentEpoch++;
        runtime.idle?.remove(command.accountId);
        if (diskAttachments)
          yield* cacheIO(() => diskAttachments.clear(command.accountId), undefined);
        runtime.attachmentCache.clear();
        const removedAccount = yield* store.getAccount(command.accountId);
        yield* (
          providers.get(removedAccount.provider).closeSessions?.(command.accountId) ?? Effect.void
        );
        // Revoke while the refresh token is still in the keychain. Best effort: removal goes on.
        yield* (
          providers.get(removedAccount.provider).revokeGrant?.(command.accountId) ?? Effect.void
        ).pipe(
          Effect.catch(() =>
            logWarning("token-revoke-failed", "Provider grant not revoked on account removal"),
          ),
        );
        // The keychain item goes before the row: if this stops halfway, the account is still
        // listed and can be removed again, so no token is left without an account.
        const keychain = yield* Effect.result(secrets.remove(command.accountId));
        const keychainLeft = keychain._tag === "Failure";
        if (keychainLeft)
          yield* logWarning(
            "keychain-remove-failed",
            "Keychain item not removed on account removal",
          );
        yield* store.removeAccount(command.accountId);
        yield* store.appendAudit({
          actor,
          accountId: command.accountId,
          action: "removeAccount",
          detail: {},
        });
        yield* changed;
        return (
          keychainLeft
            ? { status: "applied", warning: "keychain-item-left" }
            : { status: "applied" }
        ) satisfies Outcome;
      default:
        // Drafts: policy never lets one get this far.
        return yield* new InvalidInput({ message: "Drafts are never performed." });
    }
  });

  const validateAiProposal = Effect.fnUntraced(function* (command: Command) {
    if (command.kind === "modify" && command.op.kind === "label") {
      const labelId = command.op.labelId;
      for (const thread of command.threads) {
        const messages = yield* store.getThread(thread);
        const accountId = messages[0]?.accountId;
        if (!accountId)
          return yield* new InvalidInput({ message: "No account for the conversation." });
        const account = yield* store.getAccount(accountId);
        const label = (yield* store.listLabels([accountId])).find((l) => l.id === labelId);
        if (
          providerCapabilities(account.provider).organization !== "labels" ||
          !label ||
          isSpecialAgentLabel(label.id) ||
          isSpecialAgentLabel(label.name)
        )
          return yield* new InvalidInput({
            message: "AI proposals can only use existing Gmail user labels for the same account.",
          });
      }
    }
    if (command.kind === "draft") {
      const draft = command.message;
      const composeMode = draft.mode ?? (draft.inReplyTo ? "reply" : "new");
      if (
        composeMode === "forward" ||
        draft.attachments.length ||
        draft.html ||
        (composeMode === "new") === Boolean(draft.inReplyTo)
      )
        return yield* new InvalidInput({
          message: "AI proposals support plain-text new messages and replies only.",
        });
      if (
        draft.inReplyTo &&
        (yield* store.getMessage(draft.inReplyTo)).accountId !== command.accountId
      )
        return yield* new InvalidInput({
          message: "Reply message belongs to another account.",
        });
    }
    if (command.kind === "snooze" && command.due <= (yield* Clock.currentTimeMillis))
      return yield* new InvalidInput({ message: "Choose a future reminder time." });
    return yield* Effect.void;
  });

  const perform = Effect.fn("Mailbox.perform")(function* (command: Command, actor: Actor) {
    const mode = actor.kind === "agent" ? yield* store.agentWriteMode(actor.name) : "off";
    // Refuse unknown threads before anything is proposed or audited.
    if (command.kind === "snooze") {
      const now = yield* Clock.currentTimeMillis;
      if (
        !Number.isFinite(command.due) ||
        command.due <= now ||
        command.due > now + 365 * 86_400_000
      )
        return yield* new InvalidInput({
          message: "Reminder time must be within the next year.",
        });
    }
    if (command.kind === "modify" || command.kind === "snooze") {
      if (
        actor.kind === "agent" &&
        actor.surface === "mcp" &&
        (command.threads.length === 0 || command.threads.length > 20)
      )
        return yield* new InvalidInput({ message: "Proposals need 1 to 20 conversations." });
      for (const thread of command.threads) {
        if ((yield* store.threadMessageIds(thread)).length === 0) {
          return yield* new InvalidInput({ message: `No thread with id ${thread}.` });
        }
      }
    }
    if (actor.kind === "agent" && actor.surface === "mcp") yield* validateAiProposal(command);
    const decision = decide(command, actor, mode);
    if (decision.status === "denied") {
      yield* store.appendAudit({
        actor,
        action: "denied",
        detail: { command, reason: decision.reason },
      });
      return decision satisfies Outcome;
    }
    if (decision.status === "proposed") {
      // An agent's message becomes a real draft that syncs like any other
      // and waits in the Drafts list for the person to send or discard.
      const message =
        command.kind === "send" || command.kind === "draft"
          ? Option.some({ accountId: command.accountId, message: command.message })
          : Option.none();
      if (Option.isSome(message)) yield* store.getAccount(message.value.accountId);
      const proposalId = yield* store.transaction(
        Effect.gen(function* () {
          const id = yield* store.insertProposal(actor, command);
          if (Option.isSome(message)) {
            const draft = yield* store.putDraft({
              id: newDraftId(),
              ...message.value,
              message: withAgentOrigin(message.value.message, actor),
              proposalId: id,
            });
            // Read-only agents change nothing on the server: the draft
            // stays local until the person saves it from the composer.
            // Otherwise the app's next flush pushes it, not the agent's process.
            const push =
              actor.kind === "agent" &&
              !isAiProposalActor(actor) &&
              (yield* store.agentWriteMode(actor.name)) !== "off";
            if (push) yield* store.enqueueDraftSave(draft.accountId, draft.id);
          }
          yield* store.appendAudit({
            actor,
            action: "proposed",
            detail: { proposalId: id, command },
          });
          return id;
        }),
      );
      yield* changed;
      return { status: "proposed", proposalId } satisfies Outcome;
    }
    return yield* run(command, actor);
  });

  const decideProposal = Effect.fn("Mailbox.decideProposal")(function* (
    id: number,
    approve: boolean,
    surface: "app" | "cli",
  ) {
    const proposal = yield* store.getProposal(id);
    // Only the person approves, in the app. An agent with a shell could run the CLI, so a CLI
    // approval is not the person's confirmation that changes and sends need.
    if (approve && surface !== "app") return yield* new InvalidInput({ message: APPROVE_IN_APP });
    if (proposal.status !== "pending") {
      return yield* new InvalidInput({
        message: `Proposal ${id} is already ${proposal.status}.`,
      });
    }
    if (approve && isAiProposalActor(proposal.actor)) yield* validateAiProposal(proposal.command);
    const person: Actor = { kind: "user", surface };
    yield* store.setProposalStatus(id, approve ? "approved" : "rejected");
    yield* store.appendAudit({
      actor: person,
      action: approve ? "approve" : "reject",
      detail: { proposalId: id, proposer: actorLabel(proposal.actor) },
    });
    // Messages an agent proposed are sent from the compose window, as a
    // draft; sending approves the proposal. Rejecting one discards its draft.
    if (proposal.command.kind !== "modify" && proposal.command.kind !== "snooze") {
      const draft = yield* store.draftByProposal(id);
      if (!approve && Option.isSome(draft)) {
        yield* store.transaction(removeDraft(draft.value));
        yield* flushLater;
      }
      yield* changed;
      return { status: "applied" } satisfies Outcome;
    }
    yield* changed;
    if (!approve) return { status: "applied" } satisfies Outcome;
    return yield* run(proposal.command, person);
  });

  // Pulling

  const applyChanges = (
    account: Account,
    counts: { changed: number; deleted: number },
    notificationsReady: boolean,
    scope?: "inbox",
  ) => {
    const remapped = new Set<string>();
    return Effect.fnUntraced(function* (batch: readonly Change[]) {
      account = yield* store.getAccount(account.id).pipe(Effect.orDie);
      if (account.enabled === false) return;
      const prefs = yield* store.prefs;
      const now = new Date(yield* Clock.currentTimeMillis);
      const writes: Effect.Effect<void, ProviderError>[] = [];
      const newIds: string[] = [];
      const pendingById = new Map<string, MailOp[]>();
      const deletingDrafts = new Set<string>();
      for (const change of batch) {
        // Polling only discovers arrivals/flags; full sync reconciles moves and resets.
        if (
          scope &&
          ["Delete", "DeleteLabel", "Reset", "Labels", "VerifyCandidates"].includes(change._tag)
        )
          continue;
        switch (change._tag) {
          case "FetchLater":
            writes.push(
              store
                .enqueueOp(account.id, change.providerId, { kind: "reconcile" })
                .pipe(Effect.asVoid),
            );
            break;
          case "Remap":
          case "Upsert":
            counts.changed++;
            writes.push(
              Effect.gen(function* () {
                if (deletingDrafts.has(change.message.providerId)) return;
                if (
                  change._tag === "Remap" &&
                  change.message.rfcMessageId &&
                  !(yield* store.messageIdForProvider(account.id, change.message.providerId))
                ) {
                  const local = yield* store.findMessageByRfcId(
                    account.id,
                    change.message.rfcMessageId,
                    change.previous,
                  );
                  if (local && !remapped.has(local)) {
                    remapped.add(local);
                    const ref = yield* store.messageRef(local).pipe(Effect.orDie);
                    yield* store.remapProviderIds(account.id, [
                      { from: ref.providerId, to: change.message.providerId },
                    ]);
                  }
                }
                const existingId = yield* store.messageIdForProvider(
                  account.id,
                  change.message.providerId,
                );
                const id = existingId ?? `${account.id}/${change.message.providerId}`;
                const known = existingId !== null;
                // IMAP moves assign a new folder/UID while preserving the mail itself.
                const identity = providerCapabilities(account.provider).moveChangesId
                  ? sha256Hex(
                      JSON.stringify([
                        change.message.threadId,
                        change.message.date,
                        change.message.from.address,
                        change.message.subject,
                        change.message.bodyText,
                      ]),
                    )
                  : change.message.providerId;
                const first = yield* store.observeIncoming(account.id, identity);
                const remappedOps =
                  change._tag === "Remap"
                    ? (yield* store.pendingOpsForMessages(account.id, [
                        change.message.providerId,
                      ])).flatMap((pending) =>
                        pending.op.kind === "saveDraft" ||
                        pending.op.kind === "deleteDraft" ||
                        pending.op.kind === "reconcile"
                          ? []
                          : [pending.op],
                      )
                    : (pendingById.get(change.message.providerId) ?? []);
                const incoming = withPendingOps(change.message, remappedOps, account.provider);
                yield* store.upsertMessage(account.id, incoming);
                const storedId =
                  (yield* store.messageIdForProvider(account.id, incoming.providerId)) ?? id;
                if (
                  first &&
                  !known &&
                  notificationsReady &&
                  change.message.date >= (account.lastSyncedAt ?? 0) &&
                  change.message.isUnread &&
                  change.message.labels.includes("INBOX")
                ) {
                  const message = {
                    ...change.message,
                    id: storedId,
                    accountId: account.id,
                    hasAttachments: change.message.attachments.length > 0,
                  };
                  if (notificationEligible(account, message, prefs))
                    yield* store.enqueueNotification(
                      storedId,
                      !profileNotificationsActive(account, prefs, now),
                    );
                  newIds.push(storedId);
                }
              }),
            );
            // Gmail keeps the message id when a draft is sent elsewhere; it only loses DRAFT.
            if (!change.message.labels.includes("DRAFT")) {
              writes.push(store.dropSyncedDrafts(account.id, change.message.providerId));
            }
            break;
          case "Delete":
            counts.deleted++;
            writes.push(
              store.deleteMessage(account.id, change.providerId),
              // A draft deleted or sent in another client goes here too.
              store.dropSyncedDrafts(account.id, change.providerId),
            );
            break;
          case "MessageLabels":
            counts.changed++;
            if (!change.labels.includes("DRAFT"))
              writes.push(store.dropSyncedDrafts(account.id, change.providerId));
            if (!(yield* store.messageIdForProvider(account.id, change.providerId))) {
              const fetched = yield* providers
                .get(account.provider)
                .fetchMessage(account, change.providerId)
                .pipe(
                  Effect.map(Option.some),
                  Effect.catchTag("PermanentError", () => Effect.succeed(Option.none())),
                );
              if (Option.isSome(fetched))
                writes.push(
                  Effect.gen(function* () {
                    yield* store.upsertMessage(
                      account.id,
                      withPendingOps(
                        fetched.value,
                        pendingById.get(change.providerId) ?? [],
                        account.provider,
                      ),
                    );
                  }),
                );
              break;
            }
            writes.push(
              Effect.gen(function* () {
                const id = yield* store.messageIdForProvider(account.id, change.providerId);
                if (!id) return;
                const message = yield* store.getMessage(id).pipe(Effect.orDie);
                yield* store.upsertMessage(
                  account.id,
                  withPendingOps(
                    {
                      ...message,
                      providerId: change.providerId,
                      labels: [...change.labels],
                      isUnread: change.labels.includes("UNREAD"),
                      isStarred: change.labels.includes("STARRED"),
                    },
                    pendingById.get(change.providerId) ?? [],
                    account.provider,
                  ),
                );
              }),
            );
            break;
          case "Flags":
            counts.changed++;
            writes.push(
              Effect.gen(function* () {
                const id = yield* store.messageIdForProvider(account.id, change.providerId);
                if (!id) return;
                const cached = yield* store.getMessage(id).pipe(Effect.option);
                if (Option.isNone(cached)) return;
                const message = cached.value;
                const labels = applyOpToLabels(
                  applyOpToLabels(
                    message.labels.filter((label) => label !== "SNOOZED"),
                    { kind: "read", value: !change.isUnread },
                    account.provider,
                  ),
                  { kind: "star", value: change.isStarred },
                  account.provider,
                );
                yield* store.upsertMessage(
                  account.id,
                  withPendingOps(
                    {
                      ...message,
                      providerId: change.providerId,
                      labels,
                      isUnread: change.isUnread,
                      isStarred: change.isStarred,
                    },
                    pendingById.get(change.providerId) ?? [],
                    account.provider,
                  ),
                );
              }),
            );
            break;
          case "InvalidateFolder":
            writes.push(
              store.invalidateImapFolder(account.id, change.previous).pipe(
                Effect.tap(deps.batchMailbox().forgetMessages),
                Effect.asVoid,
                Effect.tap(() =>
                  Effect.sync(() => {
                    for (const id of pendingById.keys()) {
                      const ref = decodeProviderId(id);
                      if (
                        Option.isSome(ref) &&
                        ref.value.path === change.previous.path &&
                        ref.value.uidValidity === change.previous.uidValidity
                      )
                        pendingById.delete(id);
                    }
                  }),
                ),
              ),
            );
            break;
          case "VerifyCandidates":
          case "RebuildFolder":
          case "DeleteLabel":
          case "Reset":
            break; // Verification and reset barriers run outside the write transaction.
          case "BackfillReset":
            writes.push(store.resetBackfill(account.id));
            break;
          case "Labels":
            writes.push(store.replaceLabels(account.id, change.labels));
            break;
          case "Cursor":
            // A full sync covers the inbox too, so it renews the inbox cursor. Without this a
            // phone's inbox-only background polls would keep an expired Gmail history id or
            // Graph delta link after a foreground sync. A poll that ran meanwhile may have a
            // newer one; starting from the older cursor only fetches some changes again.
            writes.push(
              change.checkpoint
                ? scope
                  ? Effect.void
                  : store.saveSyncCursor(account.id, change.cursor, false)
                : scope
                  ? store.saveInboxCursor(account.id, change.cursor)
                  : store
                      .saveSyncCursor(account.id, change.cursor)
                      .pipe(Effect.andThen(store.saveInboxCursor(account.id, change.cursor))),
            );
            break;
          case "Progress":
            if (scope) break;
            writes.push(
              emit({
                _tag: "SyncProgress",
                progress: {
                  accountId: account.id,
                  fetched: change.fetched,
                  total: change.total,
                },
              }).pipe(Effect.asVoid),
            );
            break;
        }
      }
      // Changes apply in order, so a Cursor inside the batch is saved only
      // together with everything before it.
      yield* store.transaction(
        Effect.gen(function* () {
          const ids = [
            ...new Set(
              batch.flatMap((change) =>
                change._tag === "Upsert" || change._tag === "Remap"
                  ? [change.message.providerId]
                  : change._tag === "Flags" || change._tag === "MessageLabels"
                    ? [change.providerId]
                    : [],
              ),
            ),
          ];
          for (const pending of yield* store.pendingOpsForMessages(account.id, ids)) {
            if (pending.op.kind === "deleteDraft") deletingDrafts.add(pending.providerId);
            if (
              pending.op.kind === "saveDraft" ||
              pending.op.kind === "deleteDraft" ||
              pending.op.kind === "reconcile"
            )
              continue;
            const ops = pendingById.get(pending.providerId) ?? [];
            ops.push(pending.op);
            pendingById.set(pending.providerId, ops);
          }
          yield* Effect.all(writes, { discard: true });
        }),
      );
      if (newIds.length) yield* emit({ _tag: "NewMail", accountId: account.id, ids: newIds });
    });
  };
  return {
    modify,
    applyChanges,
    service: {
      importCalendarAttachment: (messageId, path, key, actor) =>
        Effect.gen(function* () {
          if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
          if (actor.kind !== "user" || actor.surface !== "app")
            return yield* new InvalidInput({
              message: "Calendar import requires confirmation in the app",
            });
          const message = yield* store.getMessage(messageId);
          const account = yield* store.getAccount(message.accountId);
          const adapter = providers.get(account.provider);
          if (
            account.enabled === false ||
            !providerCapabilities(account.provider).calendar ||
            !adapter.createCalendarEvent
          )
            return yield* new InvalidInput({
              message: "Calendar access is unavailable for this account",
            });
          const inspection = inspectAttachment(
            yield* deps.mailbox().attachmentPart(messageId, path),
          );
          const invite =
            inspection?.kind === "calendar"
              ? inspection.invites.find((i) => i.key === key && i.method === "PUBLISH")
              : undefined;
          const event = invite ? eventFromInvite(invite) : null;
          if (!event) return yield* new InvalidInput({ message: "This event cannot be imported" });
          yield* adapter.createCalendarEvent(account, event);
          yield* store.appendAudit({
            actor,
            accountId: account.id,
            action: "calendar_import",
            detail: { messageId, key },
          });
          yield* changed;
          return yield* Effect.void;
        }),

      unsubscribe: (messageId, actor) =>
        Effect.gen(function* () {
          if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
          if (actor.kind !== "user" || actor.surface !== "app")
            return yield* new InvalidInput({
              message: "Unsubscribe requires confirmation in the app",
            });
          const message = yield* store.getMessage(messageId);
          const target = message.security?.unsubscribe;
          if (target?.kind !== "post")
            return yield* new InvalidInput({
              message: "No verified one-click unsubscribe target",
            });
          const account = yield* store.getAccount(message.accountId);
          if (account.enabled === false)
            return yield* new InvalidInput({ message: "Enable this account to unsubscribe" });
          yield* unsubscribeNetwork.post(target.url);
          yield* store.appendAudit({
            actor,
            accountId: account.id,
            action: "unsubscribe",
            detail: { messageId },
          });
          return yield* Effect.void;
        }),

      perform,

      decideProposal,

      proposals: store.listProposals("pending"),

      listFailedOps: store.listFailedOps,

      acknowledgeFailedOps: (ids) => mutate(store.acknowledgeFailedOps(ids)),

      audit: (limit) => store.listAudit(limit),

      agentActivity: (limit) => store.listAgentActivity(limit),

      recordAgentActivity: (entry) => store.appendAgentActivity(entry),

      agentWriteModeFor: (name) => store.agentWriteMode(name),

      readOnlySession: readOnly,

      agentWriteMode: store.agentWriteMode("*"),

      setAgentWriteMode: (mode) => mutate(store.setAgentWriteMode("*", mode)),
    } satisfies Pick<
      Mailbox["Service"],
      | "importCalendarAttachment"
      | "unsubscribe"
      | "perform"
      | "decideProposal"
      | "proposals"
      | "listFailedOps"
      | "acknowledgeFailedOps"
      | "audit"
      | "agentActivity"
      | "recordAgentActivity"
      | "agentWriteModeFor"
      | "readOnlySession"
      | "agentWriteMode"
      | "setAgentWriteMode"
    >,
  };
};
