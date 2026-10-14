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
import type { OutgoingMessage } from "../domain/changes.js";
import { InvalidInput } from "../domain/errors.js";
import { requireFocusedInboxScope } from "../providers/scoped-adapter.js";
import { folderTarget, invalidCategoryFolderOp } from "../domain/mail-ops.js";
import { eventFromInvite } from "./mailbox-features.js";
import { type makeOrganizationMailbox } from "./mailbox-organization.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { cacheIO } from "./mailbox-shared.js";
import type {
  MailboxCalendar,
  MailboxOrganize,
  MailboxProposals,
  PerformError,
} from "./mailbox.js";
import { decide } from "./policy.js";
import { applyMailOp } from "./mail-change.js";
import { READ_ONLY_MESSAGE } from "./read-only.js";
import type { StoredDraft } from "../store/service.js";
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
    readOnly,
    unsubscribeNetwork,
    mutate,
    host,
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
        applyMailOp(store, actor, { id, accountId, providerId }, command.op),
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
            hint: "Pass a user label id from list_labels for the conversation's account. System labels such as INBOX are refused; to take a conversation out of the inbox, use action archive.",
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
          hint: "Draft a new message or a reply with a plain-text body.",
        });
      if (
        draft.inReplyTo &&
        (yield* store.getMessage(draft.inReplyTo)).accountId !== command.accountId
      )
        return yield* new InvalidInput({
          message: "Reply message belongs to another account.",
          hint: "Pass the account_id of the account that received reply_to_message_id.",
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
          return yield* new InvalidInput({
            message: `No thread with id ${thread}.`,
            hint: "Get message ids from list_threads or search.",
          });
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
  return {
    modify,
    calendar: {
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
            yield* deps.mailbox().reading.attachmentPart(messageId, path),
          );
          const invite =
            inspection?.kind === "calendar"
              ? inspection.invites.find((i) => i.key === key && i.method === "PUBLISH")
              : undefined;
          const event = invite ? eventFromInvite(invite, host.timeZone()) : null;
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
    } satisfies Pick<MailboxCalendar, "importCalendarAttachment">,
    organize: {
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
    } satisfies Pick<MailboxOrganize, "unsubscribe" | "perform">,
    proposals: {
      decideProposal,

      proposals: store.listProposals("pending"),

      proposal: (id) => store.getProposal(id),

      listFailedOps: store.listFailedOps,

      acknowledgeFailedOps: (ids) => mutate(store.acknowledgeFailedOps(ids)),

      audit: (limit) => store.listAudit(limit),

      agentActivity: (limit) => store.listAgentActivity(limit),

      recordAgentActivity: (entry) => store.appendAgentActivity(entry),

      agentWriteModeFor: (name) => store.agentWriteMode(name),

      readOnlySession: readOnly,

      agentWriteMode: store.agentWriteMode("*"),

      setAgentWriteMode: (mode) => mutate(store.setAgentWriteMode("*", mode)),
    } satisfies MailboxProposals,
  };
};
