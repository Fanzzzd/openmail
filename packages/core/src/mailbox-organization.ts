import { Clock, Effect } from "effect";
import type { ThreadQuery } from "./domain.js";
import { InvalidInput } from "./errors.js";
import type { Mailbox } from "./mailbox.js";
import {
  requiresFilterDeleteConfirmation,
  type FilterInput,
  type LabelChange,
  type SearchResult,
  type Vacation,
} from "./organization.js";
import { filterQuery, mergeSearchResults, parseSearchQuery } from "./search.js";
import type { Providers, Store } from "./services.js";

const validateFilter = (input: FilterInput) => {
  if (requiresFilterDeleteConfirmation(input) && !input.queryDeletionConfirmed)
    return new InvalidInput({ message: "Confirm deletion for a filter with a search query" });
  const c = input.criteria;
  const a = input.action;
  if (!c.from.trim() && !c.to.trim() && !c.subject.trim() && !c.query.trim() && !c.hasAttachment)
    return new InvalidInput({ message: "Add at least one filter condition" });
  if (!a.archive && !a.markRead && !a.star && !a.trash && !a.label)
    return new InvalidInput({ message: "Choose at least one filter action" });
  if ((a.trash && (a.archive || a.label)) || (a.archive && a.label))
    return new InvalidInput({ message: "Choose one destination for the filter" });
  return null;
};

/** Organization operations are app/CLI user operations; the AI toolkit does not expose them. */
export function makeOrganizationMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  changed: Effect.Effect<unknown>,
  flushLater: Effect.Effect<void>,
) {
  const owner = Effect.fnUntraced(function* (id: string) {
    const account = yield* store.getAccount(id);
    return { account, adapter: providers.get(account.provider) };
  });
  const audit = (accountId: string, action: string, detail: unknown) =>
    store.audit({ actor: { kind: "user", surface: "app" }, accountId, action, detail });
  const mutation = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.tap(() => changed));
  const searchServer = Effect.fn("Mailbox.searchServer")(function* (query: ThreadQuery) {
    const criteria = parseSearchQuery(query).criteria;
    if (
      criteria?.attachmentText ||
      criteria?.image ||
      (query.searchScope === "folder" && query.mailbox === "snoozed")
    )
      return { threads: yield* store.listThreads(query), truncated: false, errors: [] };
    const accounts = (yield* store.listAccounts).filter(
      (a) => query.accountIds === undefined || query.accountIds.includes(a.id),
    );
    const pendingBefore = yield* store.listPendingOps;
    const ids: string[] = [];
    const errors: SearchResult["errors"][number][] = [];
    let truncated = false;
    for (const account of accounts) {
      const result = yield* providers
        .get(account.provider)
        .search(account, query)
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        errors.push({ accountId: account.id, message: result.failure.message });
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
            yield* store.upsertMessage(account.id, message);
          }
        }),
      );
      ids.push(...page.messages.map((m) => `${account.id}/${m.providerId}`));
    }
    const local = yield* store.listThreads({ ...query, limit: query.limit ?? 200 });
    const remote = yield* store.listThreads({
      mailbox: "all",
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
    } satisfies SearchResult;
  });
  const changeLabel = Effect.fn("Mailbox.changeLabel")(function* (
    accountId: string,
    change: LabelChange,
  ) {
    const { account, adapter } = yield* owner(accountId);
    const labels = yield* store.listLabels([accountId]);
    if (change.kind !== "create" && !labels.some((l) => l.id === change.id))
      yield* new InvalidInput({ message: "Choose a user label or folder" });
    if (
      (change.kind === "create" || change.kind === "rename") &&
      (!change.name.trim() || /[\r\n\0]/.test(change.name))
    )
      yield* new InvalidInput({ message: "A label or folder needs a valid name" });
    if (
      change.kind === "create" &&
      change.parentId &&
      !labels.some((l) => l.id === change.parentId)
    )
      yield* new InvalidInput({ message: "Choose a parent folder from this account" });
    const current = yield* adapter.changeLabel(account, change);
    yield* store.transaction(
      Effect.gen(function* () {
        yield* store.replaceLabels(accountId, current);
        if (change.kind === "delete") yield* store.moveLabelPreference(accountId, change.id, null);
        if (change.kind === "rename" && account.provider === "imap") {
          const renamed = current.find((l) => l.name === change.name);
          if (renamed) yield* store.moveLabelPreference(accountId, change.id, renamed.id);
        }
        yield* audit(accountId, `label_${change.kind}`, change);
        if (change.kind === "color" && account.provider !== "gmail") {
          const pref = (yield* store.labelPreferences).find(
            (p) => p.accountId === accountId && p.id === change.id,
          );
          yield* store.setLabelPreference({
            accountId,
            id: change.id,
            visible: pref?.visible ?? true,
            favorite: pref?.favorite ?? false,
            color: change.color,
          });
        }
      }),
    );
    yield* changed;
  });
  const wakeSnoozed = Effect.fn("Mailbox.wakeSnoozed")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const ids = yield* store.transaction(
      Effect.gen(function* () {
        const due = yield* store.wakeSnoozed(now);
        for (const id of due) {
          const ref = yield* store.messageRef(id).pipe(Effect.orDie);
          for (const op of [{ kind: "read", value: false }, { kind: "inbox" }] as const) {
            yield* store.applyLocalOp(id, op);
            yield* store.enqueueOp(ref.accountId, ref.providerId, op);
          }
          yield* audit(ref.accountId, "snooze_due", { id });
        }
        return due;
      }),
    );
    if (ids.length) {
      yield* changed;
      yield* flushLater;
    }
  });
  const syncSendAs = Effect.fn("Mailbox.syncSendAs")(function* (accountId: string) {
    const { account, adapter } = yield* owner(accountId);
    if (account.provider !== "gmail") return;
    const aliases = yield* adapter.sendAs(account);
    yield* store.transaction(store.replaceSendAs(accountId, aliases));
    yield* changed;
  });
  return {
    searchServer,
    changeLabel,
    wakeSnoozed,
    syncSendAs,
    labelPreferences: store.labelPreferences,
    setLabelPreference: (input) =>
      mutation(
        Effect.gen(function* () {
          yield* store.getAccount(input.accountId);
          if (!(yield* store.listLabels([input.accountId])).some((l) => l.id === input.id))
            yield* new InvalidInput({ message: "Unknown label or folder" });
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
    filters: (accountId) =>
      Effect.gen(function* () {
        const { account, adapter } = yield* owner(accountId);
        return yield* adapter.filters(account);
      }),
    previewFilter: (accountId, criteria) =>
      Effect.gen(function* () {
        const { account, adapter } = yield* owner(accountId);
        const query = { ...filterQuery(criteria), accountIds: [accountId], flat: true, limit: 200 };
        if (account.provider !== "gmail") return yield* store.listThreads(query);
        const pendingBefore = yield* store.listPendingOps;
        const page = yield* adapter.search(account, query);
        yield* store.transaction(
          Effect.gen(function* () {
            const pending = [...pendingBefore, ...(yield* store.listPendingOps)];
            for (const message of page.messages) {
              if (
                !pending.some(
                  (p) => p.accountId === accountId && p.providerId === message.providerId,
                )
              )
                yield* store.upsertMessage(accountId, message);
            }
          }),
        );
        return yield* store.listThreads({
          mailbox: "all",
          flat: true,
          messageIds: page.messages.map((m) => `${accountId}/${m.providerId}`),
          limit: 200,
        });
      }),
    createFilter: (accountId, input) =>
      mutation(
        Effect.gen(function* () {
          const invalid = validateFilter(input);
          if (invalid) return yield* invalid;
          const { account, adapter } = yield* owner(accountId);
          if (
            input.action.label &&
            !(yield* store.listLabels([accountId])).some((l) => l.id === input.action.label)
          )
            return yield* new InvalidInput({
              message: "Choose a label or folder from this account",
            });
          const result = yield* adapter.createFilter(account, input);
          yield* audit(accountId, "filter_create", { id: result.id });
          return result;
        }),
      ),
    deleteFilter: (accountId, id) =>
      mutation(
        Effect.gen(function* () {
          const { account, adapter } = yield* owner(accountId);
          yield* adapter.deleteFilter(account, id);
          yield* audit(accountId, "filter_delete", { id });
        }),
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
          if (account.provider === "outlook" && (input.start === null) !== (input.end === null))
            yield* new InvalidInput({ message: "Outlook scheduled replies need both dates" });
          if (account.provider === "outlook" && input.subject)
            yield* new InvalidInput({
              message: "Outlook automatic replies do not support a custom subject",
            });
          yield* adapter.setVacation(account, input);
          yield* audit(accountId, "vacation_update", { enabled: input.enabled });
        }),
      ),
    sendAs: store.sendAs,
  } satisfies Pick<
    Mailbox["Service"],
    | "searchServer"
    | "changeLabel"
    | "wakeSnoozed"
    | "syncSendAs"
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
}
