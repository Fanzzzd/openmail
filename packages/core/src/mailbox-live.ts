import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect";

import type { Account, Actor, Command, FlushResult, Outcome, SyncResult } from "./domain.js";
import { actorLabel } from "./domain.js";
import { AuthError, InvalidInput } from "./errors.js";
import { Mailbox, type MailboxEvent, type SyncState } from "./mailbox.js";
import { toModelThread } from "./model-view.js";
import { decide } from "./policy.js";
import {
  AppConfig,
  type Change,
  type ConnectInput,
  Providers,
  Secrets,
  Store,
} from "./services.js";
import { folderTarget } from "./store.js";

/** Ops that failed this many times are dropped; the next sync restores the provider's state. */
const MAX_ATTEMPTS = 5;
/** Upserts from a pull land in transactions of this many, or every quarter second. */
const WRITE_BATCH = 200;
const DEFAULT_MODEL_CHARS = 12_000;

export interface MailboxOptions {
  /** Sync every account on this interval, starting right away. The desktop app sets it; CLI and MCP don't. */
  autoSync?: Duration.Input;
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

      const flush = Effect.fn("Mailbox.flush")(function* () {
        const result = { done: 0, failed: 0, reauth: [] as string[] };
        for (const pending of yield* store.listPendingOps) {
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
          const adapter = providers.get(account.value.provider);
          yield* adapter.push(account.value, pending.providerId, pending.op).pipe(
            Effect.andThen(store.removePendingOp(pending.id)),
            Effect.andThen(Effect.sync(() => result.done++)),
            Effect.catchTags({
              AuthError: () =>
                store
                  .setNeedsReauth(account.value.id, true)
                  .pipe(Effect.andThen(Effect.sync(() => result.reauth.push(account.value.id)))),
              PermanentError: () =>
                store
                  .removePendingOp(pending.id)
                  .pipe(Effect.andThen(Effect.sync(() => result.failed++))),
              ProviderError: (e) =>
                (pending.attempts + 1 >= MAX_ATTEMPTS
                  ? store.removePendingOp(pending.id)
                  : store.failPendingOp(pending.id, e.message)
                ).pipe(Effect.andThen(Effect.sync(() => result.failed++))),
            }),
          );
        }
        return result satisfies FlushResult;
      });

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

      const send = Effect.fn("Mailbox.send")(function* (
        command: Extract<Command, { kind: "send" }>,
        actor: Actor,
      ) {
        const { accountId, message } = command;
        if (message.to.length + message.cc.length + message.bcc.length === 0) {
          yield* new InvalidInput({ message: "A message needs at least one recipient." });
        }
        const account = yield* store.getAccount(accountId);
        if (account.needsReauth) {
          yield* new AuthError({ accountId, message: "Sign in again before sending." });
        }
        const original = message.inReplyTo
          ? Option.some({
              providerId: (yield* store.messageRef(message.inReplyTo)).providerId,
              threadId: (yield* store.getMessage(message.inReplyTo)).threadId,
            })
          : Option.none();
        const detail = {
          to: message.to.map((a) => a.address),
          cc: message.cc.map((a) => a.address),
          bcc: message.bcc.map((a) => a.address),
          subject: message.subject,
          mode: message.mode ?? "new",
          attachments: message.attachments.length,
        };
        yield* providers
          .get(account.provider)
          .send(account, message, original)
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
      });

      const run = Effect.fn("Mailbox.run")(function* (command: Command, actor: Actor) {
        switch (command.kind) {
          case "modify":
            return { status: "applied", flush: yield* modify(command, actor) } satisfies Outcome;
          case "send":
            yield* send(command, actor);
            return { status: "applied" } satisfies Outcome;
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
          const proposalId = yield* store.insertProposal(actor, command);
          yield* store.audit({ actor, action: "proposed", detail: { proposalId, command } });
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
        yield* changed;
        // Messages an agent proposed are sent from the compose window, by the
        // person, before the app marks the proposal approved.
        if (!approve || proposal.command.kind !== "modify")
          return { status: "applied" } satisfies Outcome;
        return yield* run(proposal.command, person);
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
                break;
              case "Delete":
                counts.deleted++;
                writes.push(store.deleteMessage(account.id, change.providerId));
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
                writes.push(store.deleteAccountMessages(account.id));
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
        const cursor = yield* store.getSyncCursor(account.id);
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
        return yield* providers
          .get(account.provider)
          .pull(account, cursor)
          .pipe(
            Stream.groupedWithin(WRITE_BATCH, Duration.millis(250)),
            Stream.runForEach(apply(account, counts)),
            Effect.andThen(store.setSyncError(account.id, null)),
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
        yield* sync().pipe(
          Effect.catchCause((cause) => Effect.logWarning("sync failed", cause)),
          Effect.repeat(Schedule.spaced(options.autoSync)),
          Effect.forkScoped,
        );
      }

      const mutate = <A, E>(effect: Effect.Effect<A, E>) => Effect.tap(effect, () => changed);

      return Mailbox.of({
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

        sync: (accountId) => sync(accountId),
        syncState: Ref.get(state),
        events: Stream.fromPubSub(pubsub),
      });
    }),
  );
