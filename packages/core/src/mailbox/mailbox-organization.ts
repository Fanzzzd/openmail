import { PlatformCrypto } from "../platform/crypto.js";
import { Clock, Context, Effect, Semaphore } from "effect";
import type { ThreadQuery } from "../domain/message.js";
import { requireFocusedInboxScope } from "../providers/scoped-adapter.js";
import { InvalidInput } from "../domain/errors.js";
import type { MailboxOrganize, MailboxReading } from "./mailbox.js";
import {
  SYSTEM_FOLDERS,
  systemFolderId,
  type LabelChange,
  type SearchResult,
  type Vacation,
} from "../domain/organization.js";
import { parseSearchQuery, searchHasNoWords, searchQueryError } from "../search/search.js";
import { mergeSearchResults } from "../search/ranking.js";
import { serverSearchIgnored } from "../search/provider-search.js";
import type { Providers } from "../providers/adapter.js";
import { providerCapabilities } from "../providers/capabilities.js";
import type { Store } from "../store/service.js";
import { makeFilterMailbox } from "./mailbox-filters.js";

/** Organization operations are app/CLI user operations; the AI toolkit does not expose them. */
export function makeOrganizationMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  changed: Effect.Effect<unknown>,
  flushLater: Effect.Effect<void>,
  modifyWithUndo: MailboxOrganize["modifyWithUndo"],
  crypto: PlatformCrypto = Context.get(Context.empty(), PlatformCrypto),
  onWake: (ids: readonly string[], wokenAt: number) => Effect.Effect<unknown> = () => Effect.void,
  /** Runs after a label change commits; the live mailbox syncs the account. */
  afterLabelChange: (accountId: string, change: LabelChange) => Effect.Effect<unknown> = () =>
    Effect.void,
) {
  const labelLock = Semaphore.makeUnsafe(1);
  const ruleLock = Semaphore.makeUnsafe(1);
  const owner = Effect.fnUntraced(function* (id: string) {
    const account = yield* store.getAccount(id);
    return { account, adapter: providers.get(account.provider) };
  });
  const audit = (accountId: string, action: string, detail: unknown) =>
    store.appendAudit({ actor: { kind: "user", surface: "app" }, accountId, action, detail });
  const mutation = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.tap(() => changed));
  const ruleMutation = <A, E>(effect: Effect.Effect<A, E>) =>
    ruleLock.withPermits(1)(mutation(effect));
  const searchServer = Effect.fn("Mailbox.searchServer")(function* (query: ThreadQuery) {
    const invalid = searchQueryError(query);
    if (invalid) return yield* invalid;
    // A provider would read an empty query as "all mail".
    if (query.search !== undefined && searchHasNoWords(query.search))
      return { threads: [], truncated: false, errors: [] };
    const parsed = parseSearchQuery(query);
    const criteria = parsed.criteria;
    if (
      criteria?.attachmentText ||
      criteria?.excluded?.some((condition) => condition.attachmentText) ||
      (query.searchScope === "folder" && query.mailbox === "snoozed")
    )
      return { threads: yield* store.listThreads(query), truncated: false, errors: [] };
    const accounts = (yield* store.listAccounts).filter(
      (a) =>
        a.enabled !== false && (query.accountIds === undefined || query.accountIds.includes(a.id)),
    );
    const pendingBefore = yield* store.listPendingOps;
    const ids: string[] = [];
    const errors: SearchResult["errors"][number][] = [];
    const ignored: NonNullable<SearchResult["ignored"]>[number][] = [];
    let truncated = false;
    for (const account of accounts) {
      const operators = serverSearchIgnored(query, account.provider);
      if (operators.length) ignored.push({ accountId: account.id, operators });
      const result = yield* providers
        .get(account.provider)
        .search(account, query)
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        errors.push({
          accountId: account.id,
          message: result.failure.message,
          ...(result.failure._tag === "AuthError" ? { requiresReauth: true } : {}),
        });
        continue;
      }
      const page = result.success;
      truncated ||= page.truncated;
      yield* store.transaction(
        Effect.gen(function* () {
          const pending = [...pendingBefore, ...(yield* store.listPendingOps)];
          for (const message of page.messages) {
            if (
              pending.some((p) => p.accountId === account.id && p.providerId === message.providerId)
            )
              continue;
            let next = message;
            if (message.bodyCached === false) {
              const id = yield* store.messageIdForProvider(account.id, message.providerId);
              if (id) {
                const current = yield* store.getMessage(id).pipe(Effect.orDie);
                next = { ...message, attachments: current.attachments };
              }
            }
            yield* store.upsertMessage(account.id, next);
          }
        }),
      );
      ids.push(
        ...(yield* Effect.forEach(page.messages, (m) =>
          store
            .messageIdForProvider(account.id, m.providerId)
            .pipe(Effect.map((id) => id ?? `${account.id}/${m.providerId}`)),
        )),
      );
    }
    const local = yield* store.listThreads({ ...query, limit: query.limit ?? 200 });
    const remote = yield* store.listThreads({
      mailbox: "all",
      ...query,
      searchScope: "all",
      criteria,
      unreadOnly: parsed.unreadOnly,
      starredOnly: parsed.starredOnly,
      messageIds: ids,
      flat: query.flat ?? false,
      limit: Math.max(ids.length, 1),
    });
    if (ids.length) yield* changed;
    const merged = mergeSearchResults(local, remote, query.flat);
    return {
      threads: merged.slice(0, query.limit ?? 200),
      truncated: truncated || merged.length > (query.limit ?? 200),
      errors,
      ignored,
    } satisfies SearchResult;
  });
  const changeLabelUnlocked = Effect.fn("Mailbox.changeLabel")(function* (
    accountId: string,
    change: LabelChange,
  ) {
    if (
      ("id" in change && change.id.startsWith("category:")) ||
      ("parentId" in change && change.parentId?.startsWith("category:"))
    )
      yield* new InvalidInput({
        message: "Categories cannot be renamed, deleted or moved as folders.",
      });
    if (change.kind === "create" || change.kind === "rename")
      change = { ...change, name: change.name.trim() };
    const { account, adapter } = yield* owner(accountId);
    const caps = providerCapabilities(account.provider);
    const labels = yield* store.listLabels([accountId]);
    if (change.kind !== "create" && !labels.some((l) => l.id === change.id))
      yield* new InvalidInput({ message: "Choose a user label or folder" });
    if (
      (change.kind === "create" || change.kind === "rename") &&
      (!change.name.trim() || /[\r\n\0]/.test(change.name))
    )
      yield* new InvalidInput({ message: "A label or folder needs a valid name" });
    if (
      (change.kind === "create" || change.kind === "parent") &&
      change.parentId &&
      !labels.some((l) => l.id === change.parentId)
    )
      yield* new InvalidInput({ message: "Choose a parent folder from this account" });
    if (change.kind === "visibility" && !caps.serverLabelStyle)
      yield* new InvalidInput({
        message: "Server visibility is available for Gmail labels",
      });
    if (change.kind === "parent") {
      const old = labels.find((l) => l.id === change.id);
      const parent = labels.find((l) => l.id === change.parentId);
      if (change.id === change.parentId || (old && parent?.name.startsWith(`${old.name}/`)))
        yield* new InvalidInput({ message: "A folder cannot be moved inside itself" });
    }
    // Graph and IMAP have no folder color API. Local colors do not need a
    // server listing, which can lag immediately after a folder is created.
    const current =
      change.kind === "color" && !caps.serverLabelStyle
        ? labels
        : yield* adapter.changeLabel(account, change);
    yield* store.transaction(
      Effect.gen(function* () {
        yield* store.replaceLabels(accountId, current);
        if (change.kind === "delete") yield* store.moveLabelPreference(accountId, change.id, null);
        if (
          (change.kind === "rename" || change.kind === "parent") &&
          caps.organization === "folders"
        ) {
          const old = labels.find((l) => l.id === change.id);
          const parent =
            change.kind === "parent" ? labels.find((l) => l.id === change.parentId) : null;
          const name =
            change.kind === "rename"
              ? change.name
              : `${parent ? `${parent.name}/` : ""}${old?.name.split("/").at(-1)}`;
          if (old)
            for (const previous of labels.filter(
              (l) => l.id === old.id || l.name.startsWith(`${old.name}/`),
            )) {
              const renamed = current.find(
                (l) => l.name === name + previous.name.slice(old.name.length),
              );
              if (renamed) yield* store.moveLabelPreference(accountId, previous.id, renamed.id);
            }
        }
        yield* audit(accountId, `label_${change.kind}`, change);
        if (change.kind === "color" && !caps.serverLabelStyle) {
          const pref = (yield* store.labelPreferences).find(
            (p) => p.accountId === accountId && p.id === change.id,
          );
          yield* store.setLabelPreference({
            accountId,
            id: change.id,
            visible: pref?.visible ?? true,
            favorite: pref?.favorite ?? false,
            position: pref?.position ?? 0,
            color: change.color,
          });
        }
      }),
    );
    yield* changed;
  });
  const changeLabel = (accountId: string, change: LabelChange) =>
    labelLock.withPermits(1)(changeLabelUnlocked(accountId, change));
  /**
   * Returns due conversations to the Inbox. A conversation woken by a reply
   * (`replied` holds its [accountId, threadId] key) keeps its read state and
   * raises no reminder: the reply has its own new-mail notification.
   */
  const wake = Effect.fnUntraced(function* (now: number, replied: ReadonlySet<string>) {
    const reminded = yield* store.transaction(
      Effect.gen(function* () {
        const due = yield* store.wakeSnoozed(now);
        const notified = new Set<string>();
        const timed: string[] = [];
        for (const id of due) {
          const ref = yield* store.messageRef(id).pipe(Effect.orDie);
          const message = yield* store.getMessage(id).pipe(Effect.orDie);
          const key = JSON.stringify([message.accountId, message.threadId]);
          const byReply = replied.has(key);
          for (const op of byReply
            ? ([{ kind: "inbox" }] as const)
            : ([{ kind: "read", value: false }, { kind: "inbox" }] as const)) {
            yield* store.applyLocalOp(id, op);
            yield* store.enqueueOp(ref.accountId, ref.providerId, op);
          }
          yield* audit(ref.accountId, byReply ? "snooze_reply" : "snooze_due", { id });
          if (byReply) continue;
          timed.push(id);
          if (!notified.has(key)) {
            yield* store.enqueueNotification(id, false);
            notified.add(key);
          }
        }
        return due.length ? timed : undefined;
      }),
    );
    if (reminded === undefined) return;
    if (reminded.length) yield* onWake(reminded, now);
    yield* changed;
    yield* flushLater;
  });
  const wakeSnoozed = Effect.fn("Mailbox.wakeSnoozed")(function* () {
    yield* wake(yield* Clock.currentTimeMillis, new Set());
  });
  /** New Inbox mail in a snoozed conversation ends the snooze, as in Gmail. */
  const wakeOnReply = Effect.fn("Mailbox.wakeOnReply")(function* (
    accountId: string,
    threadIds: readonly string[],
  ) {
    const now = yield* Clock.currentTimeMillis;
    const woken = yield* store.endSnoozeOnReply(accountId, threadIds, now);
    if (woken.length)
      yield* wake(now, new Set(woken.map((threadId) => JSON.stringify([accountId, threadId]))));
  });
  const syncSendAs = Effect.fn("Mailbox.syncSendAs")(function* (accountId: string) {
    const { account, adapter } = yield* owner(accountId);
    if (!providerCapabilities(account.provider).sendAs) return;
    const aliases = yield* adapter.sendAs(account);
    yield* store.transaction(store.replaceSendAs(account.id, aliases));
    yield* changed;
  });
  const filterMailbox = makeFilterMailbox({
    store,
    providers,
    changed,
    flushLater,
    crypto,
    owner,
    audit,
    ruleMutation,
  });
  const organize = {
    ...filterMailbox,
    createLabelAndApply: (accountId, name, parentId, threads, move, removeLabelId, flat) =>
      labelLock.withPermits(1)(
        Effect.gen(function* () {
          if (!threads.length) return yield* new InvalidInput({ message: "Choose a conversation" });
          for (const id of threads)
            if ((yield* store.messageRef(id)).accountId !== accountId)
              return yield* new InvalidInput({ message: "Choose messages from this account" });
          const before = yield* store.listLabels([accountId]);
          yield* changeLabelUnlocked(accountId, {
            kind: "create",
            name,
            ...(parentId ? { parentId } : {}),
          });
          const after = yield* store.listLabels([accountId]);
          const created = after.filter((l) => !before.some((old) => old.id === l.id));
          const label = created.length === 1 ? created[0] : undefined;
          if (!label)
            return yield* new InvalidInput({ message: "The new folder is not available yet" });
          return yield* modifyWithUndo(
            threads,
            move
              ? { kind: "move", labelId: label.id, removeLabelId }
              : { kind: "label", labelId: label.id, value: true },
            flat,
          );
        }),
      ),
    searchServer,
    setClassificationOverride: (messageId, classifyAs) =>
      mutation(
        Effect.gen(function* () {
          const message = yield* store.getMessage(messageId);
          const { account, adapter } = yield* owner(message.accountId);
          if (
            providerCapabilities(account.provider).inboxTabs !== "focused" ||
            !adapter.setClassificationOverride
          )
            return yield* new InvalidInput({ message: "Focused Inbox requires Outlook." });
          if (!message.from.address.trim() || /[\r\n\0]/.test(message.from.address))
            return yield* new InvalidInput({
              message: "This message has no valid sender address.",
            });
          const own = new Set(
            [
              ...(yield* store.listAccounts).map((ownedAccount) => ownedAccount.email),
              ...(yield* store.sendAs).map((alias) => alias.address),
            ].map((address) => address.trim().toLowerCase()),
          );
          if (own.has(message.from.address.trim().toLowerCase()))
            return yield* new InvalidInput({ message: "Choose a message from another sender." });
          yield* requireFocusedInboxScope(store, account.id);
          yield* adapter.setClassificationOverride(account, message.from, classifyAs);
          yield* audit(account.id, "classification_override", { messageId, classifyAs });
          return yield* Effect.void;
        }),
      ),
    changeLabel: (accountId: string, change: LabelChange) =>
      changeLabel(accountId, change).pipe(Effect.tap(() => afterLabelChange(accountId, change))),
    wakeSnoozed,
    syncSendAs,
    labelPreferences: store.labelPreferences,
    reorderFavorites: (order) =>
      mutation(
        store.transaction(
          Effect.gen(function* () {
            const preferences = yield* store.labelPreferences;
            const seen = new Set<string>();
            for (const item of order) {
              const key = JSON.stringify([item.accountId, item.id]);
              const pref = preferences.find(
                (p) => p.accountId === item.accountId && p.id === item.id && p.favorite,
              );
              if (!pref || seen.has(key))
                return yield* new InvalidInput({ message: "Choose each favorite once" });
              seen.add(key);
            }
            const selected = order.map((item) => JSON.stringify([item.accountId, item.id]));
            let next = 0;
            const favorites = preferences.filter((p) => p.favorite);
            for (const [position, pref] of favorites.entries()) {
              const key = JSON.stringify([pref.accountId, pref.id]);
              const replacement = seen.has(key) ? selected[next++] : key;
              const item = favorites.find(
                (p) => JSON.stringify([p.accountId, p.id]) === replacement,
              );
              if (item) yield* store.setLabelPreference({ ...item, position });
            }
            return yield* Effect.void;
          }),
        ),
      ),
    setLabelPreference: (input) =>
      mutation(
        Effect.gen(function* () {
          yield* store.getAccount(input.accountId);
          if (
            !SYSTEM_FOLDERS.some((id) => systemFolderId(id) === input.id) &&
            !(yield* store.listLabels([input.accountId])).some((l) => l.id === input.id)
          )
            yield* new InvalidInput({ message: "Unknown label or folder" });
          if (input.position !== undefined && !Number.isFinite(input.position))
            yield* new InvalidInput({ message: "Choose a valid favorite position" });
          yield* store.setLabelPreference(input);
        }),
      ),
    organization: store.organization,
    setOrganization: (input) =>
      mutation(
        Effect.gen(function* () {
          yield* store.getAccount(input.accountId);
          yield* store.setOrganization(input);
        }),
      ),
    snooze: (threads, due) =>
      mutation(
        store.transaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (!Number.isFinite(due) || due <= now)
              yield* new InvalidInput({ message: "Choose a future reminder time" });
            if (!threads.length) yield* new InvalidInput({ message: "Choose a conversation" });
            for (const id of threads) {
              const message = yield* store.getMessage(id);
              yield* store.snooze(id, due);
              yield* audit(message.accountId, "snooze", { id, due });
            }
          }),
        ),
      ),
    vacation: (accountId) =>
      Effect.gen(function* () {
        const { account, adapter } = yield* owner(accountId);
        return yield* adapter.vacation(account);
      }),
    setVacation: (accountId, input: Vacation) =>
      mutation(
        Effect.gen(function* () {
          if (input.enabled && !input.body.trim() && !input.outlook?.internalReplyMessage.trim())
            yield* new InvalidInput({ message: "Add an automatic reply message" });
          if (
            (input.start !== null && !Number.isFinite(input.start)) ||
            (input.end !== null && !Number.isFinite(input.end)) ||
            (input.start !== null && input.end !== null && input.start >= input.end)
          )
            yield* new InvalidInput({ message: "The end must be after the start" });
          const { account, adapter } = yield* owner(accountId);
          const vacation = providerCapabilities(account.provider).vacation;
          if (vacation?.openEnded === false && (input.start === null) !== (input.end === null))
            yield* new InvalidInput({ message: "Outlook scheduled replies need both dates" });
          if (vacation?.subject === false && input.subject)
            yield* new InvalidInput({
              message: "Outlook automatic replies do not support a custom subject",
            });
          yield* adapter.setVacation(account, input);
          yield* audit(accountId, "vacation_update", { enabled: input.enabled });
        }),
      ),
    sendAs: store.sendAs,
  } satisfies Pick<MailboxReading, "searchServer"> &
    Pick<
      MailboxOrganize,
      | "prepareFilter"
      | "filterRestorations"
      | "restoreFilter"
      | "prepareFilterRestoration"
      | "discardFilterRestoration"
      | "updateFilter"
      | "applyFilter"
      | "createLabelAndApply"
      | "setClassificationOverride"
      | "changeLabel"
      | "wakeSnoozed"
      | "syncSendAs"
      | "reorderFavorites"
      | "labelPreferences"
      | "setLabelPreference"
      | "organization"
      | "setOrganization"
      | "snooze"
      | "filters"
      | "previewFilter"
      | "createFilter"
      | "deleteFilter"
      | "vacation"
      | "setVacation"
      | "sendAs"
    >;
  return { ...organize, wakeOnReply };
}
