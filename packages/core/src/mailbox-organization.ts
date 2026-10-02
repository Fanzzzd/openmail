import { Clock, Effect, Semaphore } from "effect";
import type { MailOp, ThreadQuery, Provider } from "./domain.js";
import { InvalidInput } from "./errors.js";
import type { Mailbox } from "./mailbox.js";
import {
  requiresFilterDeleteConfirmation,
  filterDestinationsSupported,
  sameFilterRule,
  SYSTEM_FOLDERS,
  systemFolderId,
  type FilterPreview,
  type FilterInput,
  type FilterRestoration,
  type FilterRestorationPreview,
  type LabelChange,
  type SearchResult,
  type Vacation,
} from "./organization.js";
import { filterQuery, mergeSearchResults, parseSearchQuery } from "./search.js";
import type { Providers, Store } from "./services.js";

const validateFilter = (input: FilterInput, provider: Provider) => {
  if (requiresFilterDeleteConfirmation(input) && !input.queryDeletionConfirmed)
    return new InvalidInput({ message: "Confirm deletion for a filter with a search query" });
  const c = input.criteria;
  const a = input.action;
  if (!c.from.trim() && !c.to.trim() && !c.subject.trim() && !c.query.trim() && !c.hasAttachment)
    return new InvalidInput({ message: "Add at least one filter condition" });
  if (!a.archive && !a.markRead && !a.star && !a.trash && !a.label)
    return new InvalidInput({ message: "Choose at least one filter action" });
  if (!filterDestinationsSupported(a, provider))
    return new InvalidInput({ message: "Choose one destination for the filter" });
  return null;
};

const fingerprint = (input: FilterInput) =>
  JSON.stringify({ criteria: input.criteria, action: input.action, name: input.name });

const eligibleForFilter = (message: { readonly labels: readonly string[] }) =>
  !message.labels.some((label) => ["TRASH", "SPAM", "DRAFT", "SENT"].includes(label));

/** Organization operations are app/CLI user operations; the AI toolkit does not expose them. */
export function makeOrganizationMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  changed: Effect.Effect<unknown>,
  flushLater: Effect.Effect<void>,
  modifyWithUndo: Mailbox["Service"]["modifyWithUndo"],
) {
  const labelLock = Semaphore.makeUnsafe(1);
  const ruleLock = Semaphore.makeUnsafe(1);
  const owner = Effect.fnUntraced(function* (id: string) {
    const account = yield* store.getAccount(id);
    return { account, adapter: providers.get(account.provider) };
  });
  const audit = (accountId: string, action: string, detail: unknown) =>
    store.audit({ actor: { kind: "user", surface: "app" }, accountId, action, detail });
  const mutation = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.tap(() => changed));
  const ruleMutation = <A, E>(effect: Effect.Effect<A, E>) =>
    ruleLock.withPermits(1)(mutation(effect));
  const searchServer = Effect.fn("Mailbox.searchServer")(function* (query: ThreadQuery) {
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
    } satisfies SearchResult;
  });
  const changeLabelUnlocked = Effect.fn("Mailbox.changeLabel")(function* (
    accountId: string,
    change: LabelChange,
  ) {
    if (change.kind === "create" || change.kind === "rename")
      change = { ...change, name: change.name.trim() };
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
      (change.kind === "create" || change.kind === "parent") &&
      change.parentId &&
      !labels.some((l) => l.id === change.parentId)
    )
      yield* new InvalidInput({ message: "Choose a parent folder from this account" });
    if (change.kind === "visibility" && account.provider !== "gmail")
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
      change.kind === "color" && account.provider !== "gmail"
        ? labels
        : yield* adapter.changeLabel(account, change);
    yield* store.transaction(
      Effect.gen(function* () {
        yield* store.replaceLabels(accountId, current);
        if (change.kind === "delete") yield* store.moveLabelPreference(accountId, change.id, null);
        if (
          (change.kind === "rename" || change.kind === "parent") &&
          account.provider !== "gmail"
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
        if (change.kind === "color" && account.provider !== "gmail") {
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
  const wakeSnoozed = Effect.fn("Mailbox.wakeSnoozed")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const ids = yield* store.transaction(
      Effect.gen(function* () {
        const due = yield* store.wakeSnoozed(now);
        const notified = new Set<string>();
        for (const id of due) {
          const ref = yield* store.messageRef(id).pipe(Effect.orDie);
          for (const op of [{ kind: "read", value: false }, { kind: "inbox" }] as const) {
            yield* store.applyLocalOp(id, op);
            yield* store.enqueueOp(ref.accountId, ref.providerId, op);
          }
          yield* audit(ref.accountId, "snooze_due", { id });
          const message = yield* store.getMessage(id).pipe(Effect.orDie);
          const key = JSON.stringify([message.accountId, message.threadId]);
          if (!notified.has(key)) {
            yield* store.enqueueNotification(id, false);
            notified.add(key);
          }
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
  const previews = new Map<
    string,
    { accountId: string; input: string; ids: string[]; expires: number }
  >();
  const confirmPreview = Effect.fnUntraced(function* (
    accountId: string,
    input: FilterInput,
    token: string,
  ) {
    const preview = previews.get(token);
    const now = yield* Clock.currentTimeMillis;
    if (
      !preview ||
      preview.accountId !== accountId ||
      preview.input !== fingerprint(input) ||
      preview.expires <= now
    )
      return yield* new InvalidInput({ message: "Preview the rule again before confirming" });
    const account = yield* store.getAccount(accountId);
    const invalid = validateFilter(input, account.provider);
    if (invalid) return yield* invalid;
    if (
      input.action.label &&
      !(yield* store.listLabels([accountId])).some((l) => l.id === input.action.label)
    )
      return yield* new InvalidInput({ message: "Choose a label or folder from this account" });
    return preview;
  });
  const prepareFilter = Effect.fnUntraced(function* (accountId: string, input: FilterInput) {
    const { account, adapter } = yield* owner(accountId);
    const invalid = validateFilter({ ...input, queryDeletionConfirmed: true }, account.provider);
    if (invalid) return yield* invalid;
    if (
      account.provider === "imap" ||
      (account.provider === "outlook" && (input.criteria.query || input.action.star))
    )
      return yield* new InvalidInput({ message: "Unsupported server rule" });
    if (
      input.action.label &&
      !(yield* store.listLabels([accountId])).some((l) => l.id === input.action.label)
    )
      return yield* new InvalidInput({ message: "Choose a label or folder from this account" });
    const query = {
      ...filterQuery(input.criteria),
      accountIds: [accountId],
      flat: true,
      limit: 201,
    };
    const pending = yield* store.listPendingOps;
    const page = yield* adapter.search(account, query);
    yield* store.transaction(
      Effect.gen(function* () {
        const queued = [...pending, ...(yield* store.listPendingOps)];
        for (const message of page.messages)
          if (
            !queued.some((op) => op.accountId === accountId && op.providerId === message.providerId)
          )
            yield* store.upsertMessage(accountId, message);
      }),
    );
    const eligible = page.messages.filter(eligibleForFilter);
    const matches = (yield* store.listThreads({
      mailbox: "all",
      accountIds: [accountId],
      flat: true,
      messageIds: eligible.slice(0, 200).map((m) => `${accountId}/${m.providerId}`),
      limit: 200,
    })).filter(eligibleForFilter);
    const token = crypto.randomUUID();
    const now = yield* Clock.currentTimeMillis;
    for (const [key, preview] of previews) if (preview.expires <= now) previews.delete(key);
    if (previews.size >= 50) {
      const oldest = previews.keys().next().value;
      if (oldest) previews.delete(oldest);
    }
    previews.set(token, {
      accountId,
      input: fingerprint(input),
      ids: matches.map((m) => m.id),
      expires: now + 5 * 60_000,
    });
    return {
      token,
      matches,
      truncated: page.truncated || page.messages.length > 200,
    } satisfies FilterPreview;
  });
  const clearRecoveredFilter = Effect.fnUntraced(function* (backup: FilterRestoration) {
    const { account, adapter } = yield* owner(backup.accountId);
    if (account.provider !== "gmail")
      return yield* new InvalidInput({ message: "Rule recovery is available for Gmail" });
    const existing = (yield* adapter.filters(account)).find(
      (filter) => filter.editable !== false && sameFilterRule(filter, backup.input),
    );
    if (existing) {
      yield* store.deleteFilterRestoration(backup.accountId, backup.id);
      yield* audit(backup.accountId, "filter_restore_existing", {
        originalId: backup.originalId,
        id: existing.id,
      });
    }
    return existing;
  });
  return {
    prepareFilter,
    filterRestorations: (accountId) =>
      Effect.gen(function* () {
        yield* store.getAccount(accountId);
        return yield* store.filterRestorations(accountId);
      }),
    prepareFilterRestoration: (accountId, id) =>
      ruleMutation(
        Effect.gen(function* () {
          const backup = (yield* store.filterRestorations(accountId)).find(
            (item) => item.id === id,
          );
          if (!backup)
            return yield* new InvalidInput({ message: "This rule has already been restored" });
          if (yield* clearRecoveredFilter(backup))
            return { kind: "complete" } satisfies FilterRestorationPreview;
          return {
            kind: "preview",
            preview: yield* prepareFilter(accountId, backup.input),
          } satisfies FilterRestorationPreview;
        }),
      ),
    discardFilterRestoration: (accountId, id, confirmed) =>
      ruleMutation(
        Effect.gen(function* () {
          if (!confirmed)
            return yield* new InvalidInput({ message: "Confirm discarding the saved rule" });
          yield* store.getAccount(accountId);
          yield* store.deleteFilterRestoration(accountId, id);
          yield* audit(accountId, "filter_restore_discard", { id });
          return yield* Effect.void;
        }),
      ),
    restoreFilter: (accountId, id, token, queryDeletionConfirmed) =>
      ruleMutation(
        Effect.gen(function* () {
          const backup = (yield* store.filterRestorations(accountId)).find(
            (item) => item.id === id,
          );
          if (!backup)
            return yield* new InvalidInput({ message: "This rule has already been restored" });
          const existing = yield* clearRecoveredFilter(backup);
          if (existing) {
            previews.delete(token);
            return existing;
          }
          yield* confirmPreview(
            accountId,
            { ...backup.input, ...(queryDeletionConfirmed ? { queryDeletionConfirmed } : {}) },
            token,
          );
          const { account, adapter } = yield* owner(accountId);
          if (!adapter.restoreFilter || account.provider !== "gmail")
            return yield* new InvalidInput({ message: "Rule recovery is available for Gmail" });
          previews.delete(token);
          const restored = yield* adapter.restoreFilter(account, backup.definition);
          yield* store.deleteFilterRestoration(accountId, id);
          yield* audit(accountId, "filter_restore", {
            originalId: backup.originalId,
            id: restored.id,
          });
          return restored;
        }),
      ),
    updateFilter: (accountId, id, input, token) =>
      ruleMutation(
        Effect.gen(function* () {
          yield* confirmPreview(accountId, input, token);
          const { account, adapter } = yield* owner(accountId);
          const original = (yield* adapter.filters(account)).find((f) => f.id === id);
          if (original?.editable === false)
            return yield* new InvalidInput({
              message: "This rule uses conditions or actions the editor cannot preserve",
            });
          if (!original) return yield* new InvalidInput({ message: "This rule no longer exists" });
          previews.delete(token);
          const result = yield* adapter
            .updateFilter(account, id, input, (definition) =>
              store.saveFilterRestoration({
                id: crypto.randomUUID(),
                accountId,
                originalId: id,
                input: original,
                definition,
              }),
            )
            .pipe(Effect.tapError(() => changed));
          yield* audit(accountId, "filter_update", { oldId: id, id: result.id });
          return result;
        }),
      ),
    applyFilter: (accountId, input, token) =>
      ruleMutation(
        Effect.gen(function* () {
          const preview = yield* confirmPreview(accountId, input, token);
          previews.delete(token);
          const ops: MailOp[] = [
            ...(input.action.markRead ? [{ kind: "read", value: true } satisfies MailOp] : []),
            ...(input.action.star ? [{ kind: "star", value: true } satisfies MailOp] : []),
            ...(input.action.archive ? [{ kind: "archive" } satisfies MailOp] : []),
            ...(input.action.trash ? [{ kind: "trash" } satisfies MailOp] : []),
            ...(input.action.label
              ? [{ kind: "label", labelId: input.action.label, value: true } satisfies MailOp]
              : []),
          ];
          const appliedCount = yield* store.transaction(
            Effect.gen(function* () {
              let count = 0;
              for (const id of preview.ids) {
                const ref = yield* store.messageRef(id).pipe(Effect.option);
                if (ref._tag === "None") continue;
                count++;
                for (const op of ops) {
                  yield* store.applyLocalOp(id, op);
                  yield* store.enqueueOp(accountId, ref.value.providerId, op);
                }
              }
              yield* audit(accountId, "filter_apply", {
                count,
                ids: preview.ids,
              });
              return count;
            }),
          );
          yield* flushLater;
          return appliedCount;
        }),
      ),
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
    changeLabel,
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
    filters: (accountId) =>
      Effect.gen(function* () {
        const { account, adapter } = yield* owner(accountId);
        return yield* adapter.filters(account);
      }),
    previewFilter: (accountId, criteria) =>
      Effect.gen(function* () {
        const { account, adapter } = yield* owner(accountId);
        const query = { ...filterQuery(criteria), accountIds: [accountId], flat: true, limit: 200 };
        if (account.provider !== "gmail")
          return (yield* store.listThreads(query)).filter(eligibleForFilter);
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
        return (yield* store.listThreads({
          mailbox: "all",
          flat: true,
          messageIds: page.messages
            .filter(eligibleForFilter)
            .map((m) => `${accountId}/${m.providerId}`),
          limit: 200,
        })).filter(eligibleForFilter);
      }),
    createFilter: (accountId, input, token) =>
      ruleMutation(
        Effect.gen(function* () {
          yield* confirmPreview(accountId, input, token ?? "");
          const { account, adapter } = yield* owner(accountId);
          const invalid = validateFilter(input, account.provider);
          if (invalid) return yield* invalid;
          if (
            input.action.label &&
            !(yield* store.listLabels([accountId])).some((l) => l.id === input.action.label)
          )
            return yield* new InvalidInput({
              message: "Choose a label or folder from this account",
            });
          if (token) previews.delete(token);
          const result = yield* adapter.createFilter(account, input);
          yield* audit(accountId, "filter_create", { id: result.id });
          return result;
        }),
      ),
    deleteFilter: (accountId, id, confirmed = false) =>
      ruleMutation(
        Effect.gen(function* () {
          const { account, adapter } = yield* owner(accountId);
          if (!confirmed)
            return yield* new InvalidInput({ message: "Confirm deletion of this server rule" });
          yield* adapter.deleteFilter(account, id);
          yield* audit(accountId, "filter_delete", { id });
          return yield* Effect.void;
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
    | "prepareFilter"
    | "filterRestorations"
    | "restoreFilter"
    | "prepareFilterRestoration"
    | "discardFilterRestoration"
    | "updateFilter"
    | "applyFilter"
    | "createLabelAndApply"
    | "searchServer"
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
}
