import {
  Cause,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Semaphore,
  Stream,
} from "effect";

import { attachmentRef, inlineImagesFromRaw } from "./attachments.js";
import type {
  Account,
  Actor,
  Command,
  DraftInput,
  FlushResult,
  Message,
  Outcome,
  OutgoingMessage,
  SyncResult,
} from "./domain.js";
import { actorLabel } from "./domain.js";
import {
  attachmentsKey,
  importedMessage,
  originalAttachment,
  type ParsedDraft,
  parseRawDraft,
  toDraft,
} from "./drafts.js";
import { AuthError, InvalidInput, NotFound, PermanentError } from "./errors.js";
import { Mailbox, type MailboxEvent, type SyncState } from "./mailbox.js";
import { renderMarkdown } from "./markdown.js";
import { toModelThread } from "./model-view.js";
import { decide } from "./policy.js";
import {
  AppConfig,
  type Change,
  type ConnectInput,
  type PendingOp,
  Providers,
  Secrets,
  Store,
  type StoredDraft,
} from "./services.js";
import { makeOrganizationMailbox } from "./mailbox-organization.js";
import { folderTarget } from "./store.js";

/** Ops that failed this many times are dropped; the next sync restores the provider's state. */
const MAX_ATTEMPTS = 5;
/** Upserts from a pull land in transactions of this many, or every quarter second. */
const WRITE_BATCH = 200;
const DEFAULT_MODEL_CHARS = 12_000;
const DEFAULT_SUGGESTIONS = 8;

/**
 * A pull that failed on the network (no status: the connection dropped, DNS
 * failed after a wake from sleep), throttling or a 5xx is tried again before
 * the sync counts as failed. The adapters already retry each request for
 * about 8 s; this covers an outage that outlasts that.
 */
const isTransientPull = (e: { readonly _tag: string; readonly status?: number | undefined }) =>
  e._tag === "ProviderError" && (e.status === undefined || e.status === 429 || e.status >= 500);
const PULL_RETRY = {
  schedule: Schedule.exponential("5 seconds"),
  times: 2,
  while: isTransientPull,
};

const newDraftId = () => `draft:${crypto.randomUUID()}`;

export interface MailboxOptions {
  /** Sync every account on this interval, starting right away. The desktop app sets it; CLI and MCP don't. */
  autoSync?: Duration.Input;
  /**
   * Push draft saves in the background (default) so saving never waits for
   * the network. Short-lived processes and tests set false: the save then
   * returns after the push was tried.
   */
  backgroundFlush?: boolean;
}

export const MailboxLive = (
  options: MailboxOptions = {},
): Layer.Layer<Mailbox, never, Store | Providers | Secrets | AppConfig> =>
  Layer.effect(
    Mailbox,
    Effect.gen(function* () {
      const store = yield* Store;
      const providers = yield* Providers;
      const secrets = yield* Secrets;
      const config = yield* AppConfig;

      const pubsub = yield* PubSub.unbounded<MailboxEvent>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      const emit = (event: MailboxEvent) => PubSub.publish(pubsub, event);
      const changed = emit({ _tag: "Changed" });

      const state = yield* Ref.make<SyncState>({
        running: false,
        lastFinishedAt: null,
        errors: [],
      });
      const inflight = yield* Ref.make(Option.none<Deferred.Deferred<SyncResult[]>>());

      // Pushing the queue

      /** Background work (queue flushes after a draft save) that dies with the layer. */
      const background = yield* FiberSet.make();
      /** One flush at a time in this process; claims keep other processes off the same op. */
      const flushLock = yield* Semaphore.make(1);

      /**
       * A message ready for the provider: Markdown rendered, and for a forward
       * as attachment the original fetched as an .eml and the message turned
       * into a new one. `original` is what replies and forwards thread on.
       */
      const prepare = Effect.fnUntraced(function* (message: OutgoingMessage) {
        const out: OutgoingMessage = message.markdown
          ? { ...message, html: renderMarkdown(message.text) }
          : message;
        if (!message.inReplyTo) return { message: out, original: Option.none() };
        const ref = yield* store.messageRef(message.inReplyTo);
        const source = yield* store.getMessage(message.inReplyTo);
        if (!message.forwardAsAttachment) {
          return {
            message: out,
            original: Option.some({ providerId: ref.providerId, threadId: source.threadId }),
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
          attachments: [...out.attachments, originalAttachment(source.subject, raw)],
          mode: "new",
          ...(out.from ? { from: out.from } : {}),
        };
        return { message: forwarded, original: Option.none() };
      });

      /** Pushes a draft's current content. A draft discarded meanwhile loses its new copy too. */
      const pushDraft = Effect.fnUntraced(function* (account: Account, draftId: string) {
        const stored = yield* store.getDraft(draftId);
        // Discarded, or moved to another account (a newer op pushes it there).
        if (Option.isNone(stored) || stored.value.accountId !== account.id) return;
        const draft = stored.value;
        const adapter = providers.get(account.provider);
        const { message, original } = yield* prepare(draft.message).pipe(
          Effect.catchTag("NotFound", (e) =>
            Effect.fail(new PermanentError({ message: `The original ${e.what} is gone` })),
          ),
        );
        const key = attachmentsKey(message.attachments);
        const remote = yield* adapter.saveDraft(account, {
          remote: draft.remote,
          message,
          original,
          replaceAttachments: key !== draft.pushedAttachments,
        });
        if (!(yield* store.setDraftRemote(draftId, remote, key))) {
          yield* adapter.deleteDraft(account, remote);
          return;
        }
        // Gmail and IMAP replace the message; the old local copy would show twice.
        const old = draft.remote?.messageId;
        if (old && old !== remote.messageId) yield* store.deleteMessage(account.id, old);
        // A reader showing the old copy, or the Drafts list, has to look again.
        // Pushes run in the background, so nothing else tells the app.
        if (old !== remote.messageId) yield* changed;
      });

      const pushOp = (account: Account, pending: PendingOp) => {
        const { op } = pending;
        switch (op.kind) {
          case "saveDraft":
            return pushDraft(account, op.draftId);
          case "deleteDraft":
            return providers.get(account.provider).deleteDraft(account, op.remote);
          default:
            return providers.get(account.provider).push(account, pending.providerId, op);
        }
      };

      const flush = Effect.fn("Mailbox.flush")(function* () {
        const result = { done: 0, failed: 0, reauth: [] as string[] };
        const blocked = new Set<string>();
        for (const pending of yield* store.listPendingOps) {
          const key = `${pending.accountId}/${pending.providerId}`;
          if (blocked.has(key)) continue;
          if (result.reauth.includes(pending.accountId)) continue;
          const account = yield* store.getAccount(pending.accountId).pipe(Effect.option);
          if (Option.isNone(account)) {
            yield* store.removePendingOp(pending.id);
            continue;
          }
          if (account.value.needsReauth) {
            result.reauth.push(account.value.id);
            continue;
          }
          if (!(yield* store.claimPendingOp(pending.id))) {
            blocked.add(key);
            continue;
          }
          yield* pushOp(account.value, pending).pipe(
            Effect.andThen(store.removePendingOp(pending.id)),
            Effect.andThen(Effect.sync(() => result.done++)),
            Effect.catchTags({
              AuthError: () =>
                Effect.all([
                  store.setNeedsReauth(account.value.id, true),
                  store.releasePendingOp(pending.id),
                  Effect.sync(() => result.reauth.push(account.value.id)),
                ]),
              PermanentError: () =>
                store
                  .removePendingOp(pending.id)
                  .pipe(Effect.andThen(Effect.sync(() => result.failed++))),
              ProviderError: (e) =>
                Effect.gen(function* () {
                  blocked.add(key);
                  yield* pending.attempts + 1 >= MAX_ATTEMPTS
                    ? store.removePendingOp(pending.id)
                    : store.failPendingOp(pending.id, e.message);
                  result.failed++;
                }),
            }),
          );
        }
        return result satisfies FlushResult;
      }, flushLock.withPermits(1));

      /** Flushes without making the caller wait for the network. */
      const flushNow = flush().pipe(
        Effect.flatMap((result) => (result.reauth.length ? changed : Effect.void)),
        Effect.catchCause((cause) => Effect.logWarning("flush failed", cause)),
      );
      const flushLater =
        options.backgroundFlush === false
          ? flushNow
          : FiberSet.run(background, flushNow).pipe(Effect.asVoid);

      const organization = makeOrganizationMailbox(store, providers, changed, flushLater);

      // Running commands

      const modify = Effect.fn("Mailbox.modify")(function* (
        command: Extract<Command, { kind: "modify" }>,
        actor: Actor,
      ) {
        const ids = new Set<string>();
        for (const thread of command.threads) {
          for (const id of yield* store.threadMessageIds(thread)) ids.add(id);
        }
        if (ids.size === 0) {
          return yield* new InvalidInput({ message: "No message matches the given thread ids." });
        }
        const accounts = new Map<string, Account>();
        for (const id of ids) {
          const { accountId, providerId } = yield* store.messageRef(id);
          let account = accounts.get(accountId);
          if (!account) {
            account = yield* store.getAccount(accountId);
            accounts.set(accountId, account);
          }
          // On folder providers some ops change nothing: `important` has no
          // equivalent, and removing a label the message is not in moves nothing.
          const flag = command.op.kind === "read" || command.op.kind === "star";
          if (account.provider !== "gmail" && !flag) {
            const labels = yield* store.messageLabels(accountId, providerId);
            if (!folderTarget(command.op, labels)) continue;
          }
          yield* store.transaction(
            Effect.all([
              store.applyLocalOp(id, command.op),
              store.enqueueOp(accountId, providerId, command.op),
              store.audit({
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

      /** Settles an agent's message proposal once the person sent or discarded its draft. */
      const settleProposal = Effect.fnUntraced(function* (proposalId: number, approve: boolean) {
        const proposal = yield* store.getProposal(proposalId).pipe(Effect.option);
        if (Option.isNone(proposal) || proposal.value.status !== "pending") return;
        yield* store.setProposalStatus(proposalId, approve ? "approved" : "rejected");
        yield* store.audit({
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

      const send = Effect.fn("Mailbox.send")(function* (
        command: Extract<Command, { kind: "send" }>,
        actor: Actor,
      ) {
        const { accountId, message } = command;
        if (message.to.length + message.cc.length + message.bcc.length === 0) {
          yield* new InvalidInput({ message: "A message needs at least one recipient." });
        }
        const account = yield* store.getAccount(accountId);
        if (message.from && message.from.address.toLowerCase() !== account.email.toLowerCase()) {
          const aliases = yield* store.sendAs;
          if (
            account.provider !== "gmail" ||
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
        if (account.needsReauth) {
          yield* new AuthError({ accountId, message: "Sign in again before sending." });
        }
        const prepared = yield* prepare(message);
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
        yield* providers
          .get(account.provider)
          .send(account, prepared.message, prepared.original)
          .pipe(
            Effect.tapError((error) =>
              Effect.all([
                error._tag === "AuthError" ? store.setNeedsReauth(accountId, true) : Effect.void,
                store.audit({
                  actor,
                  accountId,
                  action: "send_failed",
                  detail: { ...detail, error: error.message },
                }),
              ]),
            ),
          );
        yield* store.audit({ actor, accountId, action: "send", detail });

        // The mail is out. What follows only tidies up and must not fail the send.
        const draft = command.draftId
          ? yield* store.getDraft(command.draftId)
          : Option.none<StoredDraft>();
        if (Option.isSome(draft)) {
          yield* store.transaction(removeDraft(draft.value));
          if (draft.value.proposalId !== null) yield* settleProposal(draft.value.proposalId, true);
        }
        let flushed: FlushResult | undefined;
        if (command.archive && message.inReplyTo) {
          flushed = yield* modify(
            { kind: "modify", threads: [message.inReplyTo], op: { kind: "archive" } },
            actor,
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Sent, but archiving failed: ${error.message}`).pipe(
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

      const run = Effect.fn("Mailbox.run")(function* (command: Command, actor: Actor) {
        switch (command.kind) {
          case "modify":
            return { status: "applied", flush: yield* modify(command, actor) } satisfies Outcome;
          case "send": {
            const flushed = yield* send(command, actor);
            return (
              flushed ? { status: "applied", flush: flushed } : { status: "applied" }
            ) satisfies Outcome;
          }
          case "removeAccount":
            yield* store.getAccount(command.accountId);
            yield* store.removeAccount(command.accountId);
            yield* secrets.remove(command.accountId);
            yield* store.audit({
              actor,
              accountId: command.accountId,
              action: "removeAccount",
              detail: {},
            });
            yield* changed;
            return { status: "applied" } satisfies Outcome;
          default:
            // Drafts: policy never lets one get this far.
            return yield* new InvalidInput({ message: "Drafts are never performed." });
        }
      });

      const perform = Effect.fn("Mailbox.perform")(function* (command: Command, actor: Actor) {
        const mode =
          actor.kind === "agent" && command.kind === "modify"
            ? yield* store.agentWriteMode(actor.name)
            : "off";
        // Refuse unknown threads before anything is proposed or audited.
        if (command.kind === "modify") {
          for (const thread of command.threads) {
            if ((yield* store.threadMessageIds(thread)).length === 0) {
              return yield* new InvalidInput({ message: `No thread with id ${thread}.` });
            }
          }
        }
        const decision = decide(command, actor, mode);
        if (decision.status === "denied") {
          yield* store.audit({
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
                  proposalId: id,
                });
                // Read-only agents change nothing on the server: the draft
                // stays local until the person saves it from the composer.
                // Otherwise the app's next flush pushes it, not the agent's process.
                const push =
                  actor.kind === "agent" && (yield* store.agentWriteMode(actor.name)) !== "off";
                if (push) yield* store.enqueueDraftSave(draft.accountId, draft.id);
              }
              yield* store.audit({
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
        if (proposal.status !== "pending") {
          return yield* new InvalidInput({
            message: `Proposal ${id} is already ${proposal.status}.`,
          });
        }
        const person: Actor = { kind: "user", surface };
        yield* store.setProposalStatus(id, approve ? "approved" : "rejected");
        yield* store.audit({
          actor: person,
          action: approve ? "approve" : "reject",
          detail: { proposalId: id, proposer: actorLabel(proposal.actor) },
        });
        // Messages an agent proposed are sent from the compose window, as a
        // draft; sending approves the proposal. Rejecting one discards its draft.
        if (proposal.command.kind !== "modify") {
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

      // Drafts

      const saveDraft = Effect.fn("Mailbox.saveDraft")(function* (input: DraftInput) {
        yield* store.getAccount(input.accountId);
        const saved = yield* store.transaction(
          Effect.gen(function* () {
            const existing = yield* store.getDraft(input.id);
            if (Option.isSome(existing)) {
              const old = existing.value;
              // A new From account: the copy on the old account goes.
              if (old.accountId !== input.accountId && old.remote) {
                yield* removeDraft(old);
              }
            } else {
              yield* store.audit({
                actor: { kind: "user", surface: "app" },
                accountId: input.accountId,
                action: "draft",
                detail: { draftId: input.id, subject: input.message.subject },
              });
            }
            const draft = yield* store.putDraft({
              id: input.id,
              accountId: input.accountId,
              message: input.message,
            });
            yield* store.enqueueDraftSave(input.accountId, input.id);
            return draft;
          }),
        );
        yield* flushLater;
        // With an inline flush the push already happened; show that.
        return toDraft(Option.getOrElse(yield* store.getDraft(input.id), () => saved));
      });

      const discardDraft = Effect.fn("Mailbox.discardDraft")(function* (id: string) {
        const draft = yield* store.getDraft(id);
        if (Option.isNone(draft)) return;
        yield* store.transaction(
          Effect.gen(function* () {
            yield* removeDraft(draft.value);
            yield* store.audit({
              actor: { kind: "user", surface: "app" },
              accountId: draft.value.accountId,
              action: "discard_draft",
              detail: { draftId: id, subject: draft.value.message.subject },
            });
          }),
        );
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
          text: message.bodyText,
          attachments: [],
          isReply: false,
        };
        const parsed = yield* providers
          .get(account.provider)
          .fetchRaw(account, providerId)
          .pipe(
            Effect.flatMap(parseRawDraft),
            // Offline: without attachments the stored copy has everything.
            Effect.catch((error) =>
              message.attachments.length > 0 ? Effect.fail(error) : Effect.succeed(fallback),
            ),
          );
        const thread = yield* store.getThread(message.id);
        return yield* store.transaction(
          Effect.gen(function* () {
            const draft = yield* store.putDraft({
              id: newDraftId(),
              accountId: account.id,
              message: importedMessage(parsed, thread),
            });
            yield* store.setDraftRemote(
              draft.id,
              // Gmail's draft id is looked up by message id when first needed.
              { draftId: account.provider === "gmail" ? null : providerId, messageId: providerId },
              attachmentsKey(parsed.attachments),
            );
            return yield* store.getDraft(draft.id).pipe(Effect.map(Option.getOrThrow));
          }),
        );
      });

      const openDraft = Effect.fn("Mailbox.openDraft")(function* (id: string) {
        const proposalRef = /^proposal:(\d+)$/.exec(id);
        if (proposalRef) {
          const proposalId = Number(proposalRef[1]);
          const linked = yield* store.draftByProposal(proposalId);
          if (Option.isSome(linked)) return toDraft(linked.value);
          // A proposal from before drafts were synced: it becomes one now.
          const proposal = yield* store.getProposal(proposalId);
          const { command } = proposal;
          if (command.kind !== "send" && command.kind !== "draft") {
            return yield* new InvalidInput({ message: `Proposal ${proposalId} is not a message.` });
          }
          const draft = yield* store.putDraft({
            id: newDraftId(),
            accountId: command.accountId,
            message: command.message,
            proposalId,
          });
          yield* store.enqueueDraftSave(draft.accountId, draft.id);
          return toDraft(draft);
        }
        const local = yield* store.getDraft(id);
        if (Option.isSome(local)) return toDraft(local.value);
        const message = yield* store.getMessage(id);
        const { providerId } = yield* store.messageRef(id);
        const linked = yield* store.draftByRemoteMessage(message.accountId, providerId);
        if (Option.isSome(linked)) return toDraft(linked.value);
        if (!message.labels.includes("DRAFT")) {
          return yield* new InvalidInput({ message: "This message is not a draft." });
        }
        const imported = toDraft(yield* importDraft(message));
        yield* changed;
        return imported;
      });

      // Reading from the provider

      const source = Effect.fnUntraced(function* (id: string) {
        const ref = yield* store.messageRef(id);
        const account = yield* store.getAccount(ref.accountId);
        return { account, adapter: providers.get(account.provider), providerId: ref.providerId };
      });

      const rawMessage = Effect.fn("Mailbox.rawMessage")(function* (id: string) {
        const { account, adapter, providerId } = yield* source(id);
        const raw = yield* adapter.fetchRaw(account, providerId);
        // Headers are ASCII; 8-bit bodies in other charsets show replacement characters.
        return new TextDecoder("utf-8").decode(raw);
      });

      const attachment = Effect.fn("Mailbox.attachment")(function* (
        messageId: string,
        index: number,
      ) {
        const message = yield* store.getMessage(messageId);
        const listed = message.attachments[index];
        const ref = attachmentRef(message.attachments, index);
        if (!listed || !ref) {
          return yield* new NotFound({ what: "attachment", id: `${messageId}#${index}` });
        }
        const { account, adapter, providerId } = yield* source(messageId);
        const data = yield* adapter.fetchAttachment(account, providerId, ref);
        return { filename: listed.filename, mimeType: listed.mimeType, data };
      });

      const inlineImages = Effect.fn("Mailbox.inlineImages")(function* (messageId: string) {
        const { account, adapter, providerId } = yield* source(messageId);
        return yield* adapter
          .fetchRaw(account, providerId)
          .pipe(Effect.flatMap(inlineImagesFromRaw));
      });

      // Pulling

      const apply = (account: Account, counts: { changed: number; deleted: number }) =>
        Effect.fnUntraced(function* (batch: readonly Change[]) {
          const writes: Effect.Effect<void>[] = [];
          for (const change of batch) {
            switch (change._tag) {
              case "Upsert":
                counts.changed++;
                writes.push(store.upsertMessage(account.id, change.message));
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
              case "Flags":
                counts.changed++;
                writes.push(
                  store.setFlags(account.id, change.providerId, {
                    isUnread: change.isUnread,
                    isStarred: change.isStarred,
                  }),
                );
                break;
              case "DeleteLabel":
                writes.push(store.deleteMessagesWithLabel(account.id, change.label));
                break;
              case "Reset":
                writes.push(
                  store.deleteAccountMessages(account.id),
                  // Their copies come back under new ids and open as drafts again.
                  store.dropSyncedDrafts(account.id),
                );
                break;
              case "Labels":
                writes.push(store.replaceLabels(account.id, change.labels));
                break;
              case "Cursor":
                writes.push(store.saveSyncCursor(account.id, change.cursor));
                break;
              case "Progress":
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
          yield* store.transaction(Effect.all(writes, { discard: true }));
        });

      const pullAccount = Effect.fn("Mailbox.pullAccount")(function* (account: Account) {
        const counts = { changed: 0, deleted: 0 };
        if (account.needsReauth) {
          return { accountId: account.id, ...counts, error: "Sign in again", needsReauth: true };
        }
        const failed = (text: string, auth: boolean) =>
          Effect.gen(function* () {
            if (auth) yield* store.setNeedsReauth(account.id, true);
            yield* store.setSyncError(account.id, text);
            return {
              accountId: account.id,
              ...counts,
              error: text,
              ...(auth ? { needsReauth: true } : {}),
            } satisfies SyncResult;
          });
        // A retry starts from the cursor the failed attempt left: batches it
        // wrote stay, and the cursor only moves once a whole pull is in.
        const pull = Effect.sync(() => {
          counts.changed = 0;
          counts.deleted = 0;
        }).pipe(
          Effect.andThen(store.getSyncCursor(account.id)),
          Effect.flatMap((cursor) =>
            providers
              .get(account.provider)
              .pull(account, cursor)
              .pipe(
                Stream.groupedWithin(WRITE_BATCH, Duration.millis(250)),
                Stream.runForEach(apply(account, counts)),
              ),
          ),
        );
        return yield* pull.pipe(
          Effect.retry(PULL_RETRY),
          Effect.andThen(store.setSyncError(account.id, null)),
          Effect.andThen(
            account.provider === "gmail"
              ? providers
                  .get("gmail")
                  .sendAs(account)
                  .pipe(
                    Effect.flatMap((aliases) =>
                      store.transaction(store.replaceSendAs(account.id, aliases)),
                    ),
                    // Settings permission is optional for existing mail accounts.
                    Effect.catch(() => Effect.void),
                  )
              : Effect.void,
          ),
          // `counts` is filled while the stream runs, so read it afterwards.
          Effect.map(() => ({ accountId: account.id, ...counts }) satisfies SyncResult),
          Effect.catch((error) => failed(error.message, error._tag === "AuthError")),
          // A bug in one provider must not stop the other accounts from syncing.
          Effect.catchCause((cause) =>
            Effect.logError("sync crashed", cause).pipe(
              Effect.andThen(failed(String(Cause.squash(cause)), false)),
            ),
          ),
        );
      });

      const runSync = Effect.fn("Mailbox.runSync")(function* (accountId?: string) {
        yield* Ref.update(state, (s) => ({ ...s, running: true }));
        yield* emit({ _tag: "SyncState", state: yield* Ref.get(state) });
        yield* organization.wakeSnoozed();
        // Queued local changes go out first so the pull does not undo them.
        yield* flush();
        const accounts = accountId
          ? [yield* store.getAccount(accountId).pipe(Effect.orDie)]
          : yield* store.listAccounts;
        const results: SyncResult[] = [];
        // One failing account does not stop the rest.
        for (const account of accounts) results.push(yield* pullAccount(account));
        const next: SyncState = {
          running: false,
          lastFinishedAt: Date.now(),
          errors: results.flatMap((r) => (r.error ? [`${r.accountId}: ${r.error}`] : [])),
        };
        yield* Ref.set(state, next);
        yield* emit({ _tag: "SyncState", state: next });
        yield* changed;
        return results;
      });

      /** One sync at a time: a call during a run waits for that run instead of starting another. */
      const sync = Effect.fn("Mailbox.sync")(function* (accountId?: string) {
        const current = yield* Ref.get(inflight);
        if (Option.isSome(current)) return yield* Deferred.await(current.value);
        const done = yield* Deferred.make<SyncResult[]>();
        yield* Ref.set(inflight, Option.some(done));
        return yield* runSync(accountId).pipe(
          Effect.onExit((exit) =>
            Ref.set(inflight, Option.none()).pipe(
              Effect.andThen(Deferred.done(done, exit)),
              Effect.andThen(
                exit._tag === "Failure"
                  ? Ref.update(state, (s) => ({ ...s, running: false }))
                  : Effect.void,
              ),
            ),
          ),
        );
      });

      // Accounts

      const connect = Effect.fn("Mailbox.connect")(function* (
        input: ConnectInput,
        expect?: string,
      ) {
        const connected = yield* providers.get(input.provider).connect(input);
        if (expect && connected.email.toLowerCase() !== expect.toLowerCase()) {
          return yield* new InvalidInput({
            message: `Signed in as ${connected.email}, expected ${expect}.`,
          });
        }
        const account = yield* store.upsertAccount(input.provider, connected.email);
        yield* secrets.set(account.id, connected.secret);
        if (connected.imap) yield* store.setImapSettings(account.id, connected.imap);
        yield* store.setNeedsReauth(account.id, false);
        yield* store.setSyncError(account.id, null);
        yield* store.audit({
          actor: { kind: "user", surface: "app" },
          accountId: account.id,
          action: "connect",
          detail: {},
        });
        yield* changed;
        yield* Effect.forkDetach(sync());
        return yield* store.getAccount(account.id).pipe(Effect.orDie);
      });

      const reauth = Effect.fn("Mailbox.reauth")(function* (accountId: string) {
        const account = yield* store.getAccount(accountId);
        if (account.provider === "imap") {
          return yield* new InvalidInput({
            message: "IMAP accounts sign in again by adding the address with a new password.",
          });
        }
        return yield* connect(
          { provider: account.provider, loginHint: account.email },
          account.email,
        );
      });

      if (options.autoSync !== undefined) {
        yield* organization
          .wakeSnoozed()
          .pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
        yield* sync().pipe(
          Effect.catchCause((cause) => Effect.logWarning("sync failed", cause)),
          Effect.repeat(Schedule.spaced(options.autoSync)),
          Effect.forkScoped,
        );
      }

      const mutate = <A, E>(effect: Effect.Effect<A, E>) => Effect.tap(effect, () => changed);

      return Mailbox.of({
        ...organization,
        changeLabel: (accountId, change) =>
          organization
            .changeLabel(accountId, change)
            .pipe(
              Effect.tap(() =>
                change.kind === "color"
                  ? Effect.void
                  : options.backgroundFlush === false
                    ? sync(accountId).pipe(Effect.asVoid)
                    : FiberSet.run(background, sync(accountId)).pipe(Effect.asVoid),
              ),
            ),
        accounts: store.listAccounts,
        connect: (input) => connect(input),
        reauth,
        clientSetup: Effect.map(config.read, (c) => ({
          googleConfigured: Boolean(c.google),
          microsoftConfigured: Boolean(c.microsoft),
        })),
        setClient: (patch) => mutate(config.write(patch)),

        threads: (q) => store.listThreads(q),
        thread: (id) => store.getThread(id),
        threadForModel: (id, maxChars = DEFAULT_MODEL_CHARS) =>
          Effect.map(store.getThread(id), (messages) => toModelThread(messages, maxChars)),
        rawMessage,
        attachment,
        inlineImages,
        imageSenders: store.imageSenders,
        setImageSender: (entry, allowed) => mutate(store.setImageSender(entry, allowed)),
        labels: (accountIds) => store.listLabels(accountIds),
        unreadCounts: store.unreadCounts,
        unreadByLabel: (accountIds, within) => store.unreadByLabel(accountIds, within),

        profiles: store.listProfiles,
        createProfile: (input) => mutate(store.createProfile(input)),
        updateProfile: (id, input) => mutate(store.updateProfile(id, input)),
        deleteProfile: (id) => mutate(store.deleteProfile(id)),
        assignProfile: (accountId, profileId) =>
          mutate(store.setAccountProfile(accountId, profileId)),

        perform,
        decideProposal,
        proposals: store.listProposals("pending"),
        audit: (limit) => store.listAudit(limit),
        agentWriteMode: store.agentWriteMode("*"),
        setAgentWriteMode: (mode) => mutate(store.setAgentWriteMode("*", mode)),

        openDraft,
        saveDraft,
        discardDraft,

        prefs: store.prefs,
        setPrefs: (patch) => mutate(store.setPrefs(patch)),
        signatures: store.signatures,
        setSignature: (signature) => mutate(store.setSignature(signature)),
        templates: store.templates,
        saveTemplate: (input, id) => mutate(store.saveTemplate(id ?? null, input)),
        deleteTemplate: (id) => mutate(store.deleteTemplate(id)),

        suggestContacts: (query, { limit = DEFAULT_SUGGESTIONS, exclude } = {}) =>
          store.suggestContacts(query, limit, exclude),
        hiddenContacts: store.hiddenContacts,
        setContactHidden: (address, hidden) => mutate(store.setContactHidden(address, hidden)),

        sync: (accountId) => sync(accountId),
        syncState: Ref.get(state),
        events: Stream.fromPubSub(pubsub),
      });
    }),
  );
