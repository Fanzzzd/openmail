import { PlatformCrypto } from "../platform/crypto.js";
import { Clock, Effect } from "effect";
import type { Account, Label, Provider } from "../domain/account.js";
import type { MailOp } from "../domain/changes.js";
import type { ThreadQuery } from "../domain/message.js";
import { InvalidInput } from "../domain/errors.js";
import {
  requiresFilterDeleteConfirmation,
  outlookServerOnlyAction,
  filterDestinationsSupported,
  sameFilterRule,
  type FilterPreview,
  type FilterInput,
  type FilterRestoration,
  type FilterRestorationPreview,
} from "../domain/organization.js";
import { filterQuery, searchQueryError } from "../search/search.js";
import type { Providers } from "../providers/adapter.js";
import type { Store } from "../store/service.js";
import {
  evaluateOutlookRule,
  outlookPreviewUnavailable,
  validOutlookPredicates,
} from "../providers/outlook/outlook-rules.js";
import type { Mailbox } from "./mailbox.js";

const validateFilter = (input: FilterInput, provider: Provider) => {
  if (requiresFilterDeleteConfirmation(input) && !input.queryDeletionConfirmed)
    return new InvalidInput({ message: "Confirm deletion for this rule" });
  const c = input.criteria;
  const a = input.action;
  if (
    (provider !== "outlook" && (c.outlook || c.outlookExceptions)) ||
    (provider !== "gmail" && c.excludeChats) ||
    !validOutlookPredicates(c.outlook) ||
    !validOutlookPredicates(c.outlookExceptions) ||
    (c.size !== undefined && c.outlook?.withinSizeRange)
  )
    return new InvalidInput({ message: "Unsupported server rule" });
  if (provider === "outlook" && c.exceptAttachment === false)
    return new InvalidInput({ message: "Unsupported server rule" });
  if (
    !c.from.trim() &&
    !c.to.trim() &&
    !c.subject.trim() &&
    !c.query.trim() &&
    !c.hasAttachment &&
    !c.hasWords?.trim() &&
    !c.notWords?.trim() &&
    !c.exceptFrom?.trim() &&
    !c.exceptTo?.trim() &&
    !c.exceptSubject?.trim() &&
    c.exceptAttachment === undefined &&
    c.size === undefined &&
    !c.excludeChats &&
    !Object.keys(c.outlook ?? {}).length &&
    !Object.keys(c.outlookExceptions ?? {}).length
  )
    return new InvalidInput({ message: "Add at least one filter condition" });
  if (
    !a.archive &&
    !a.markRead &&
    !a.star &&
    !a.trash &&
    !a.label &&
    !a.labels?.length &&
    a.important === undefined &&
    !a.category &&
    !a.stopProcessing &&
    !a.markImportance &&
    !a.assignCategories?.length &&
    !a.copyToFolder &&
    !a.addLabelIds?.length &&
    !a.removeLabelIds?.length
  )
    return new InvalidInput({ message: "Choose at least one filter action" });
  if (c.size !== undefined && (!Number.isSafeInteger(c.size) || c.size < 0 || !c.sizeComparison))
    return new InvalidInput({ message: "Choose a size in bytes and a comparison" });
  if (provider === "outlook" && c.size !== undefined && c.size % 1024 !== 0)
    return new InvalidInput({ message: "Outlook rule sizes must be a multiple of 1024 bytes" });
  if (
    provider !== "outlook" &&
    (c.exceptFrom || c.exceptTo || c.exceptSubject || c.exceptAttachment !== undefined)
  )
    return new InvalidInput({ message: "Unsupported server rule" });
  if (!filterDestinationsSupported(a, provider))
    return new InvalidInput({ message: "Choose one destination for the filter" });
  return null;
};

const fingerprint = (input: FilterInput) =>
  JSON.stringify({ criteria: input.criteria, action: input.action, name: input.name });

const eligibleForFilter = (message: { readonly labels: readonly string[] }) =>
  !message.labels.some((label) => ["TRASH", "SPAM", "DRAFT", "SENT"].includes(label));

function unknownRuleLabel(input: FilterInput, labels: readonly Pick<Label, "id">[]) {
  return [
    input.action.label,
    input.action.copyToFolder,
    ...(input.action.labels ?? []),
    ...(input.action.addLabelIds ?? []).filter((id) => id.startsWith("Label_")),
    ...(input.action.removeLabelIds ?? []).filter((id) => id.startsWith("Label_")),
  ].find((id) => id && !labels.some((label) => label.id === id));
}

export function labelOps(ids: readonly string[], value: boolean): MailOp[] {
  return ids.map((labelId): MailOp => {
    switch (labelId) {
      case "UNREAD":
        return { kind: "read", value: !value };
      case "STARRED":
        return { kind: "star", value };
      case "IMPORTANT":
        return { kind: "important", value };
      default:
        return { kind: "label", labelId, value };
    }
  });
}

/** Server rules: validation, previews against local and server mail, and confirmed create, update, apply, delete and restore. */
export function makeFilterMailbox({
  store,
  providers,
  changed,
  flushLater,
  crypto,
  owner,
  audit,
  ruleMutation,
}: {
  store: Store["Service"];
  providers: Providers["Service"];
  changed: Effect.Effect<unknown>;
  flushLater: Effect.Effect<void>;
  crypto: PlatformCrypto;
  owner: (
    id: string,
  ) => Effect.Effect<
    { account: Account; adapter: ReturnType<Providers["Service"]["get"]> },
    Effect.Error<ReturnType<Store["Service"]["getAccount"]>>
  >;
  audit: (accountId: string, action: string, detail: unknown) => Effect.Effect<void>;
  ruleMutation: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}) {
  const cacheSearchPage = Effect.fnUntraced(function* (account: Account, query: ThreadQuery) {
    const invalid = searchQueryError(query);
    if (invalid) return yield* invalid;
    const pendingBefore = yield* store.listPendingOps;
    const page = yield* providers.get(account.provider).search(account, query);
    yield* store.transaction(
      Effect.gen(function* () {
        const pending = [...pendingBefore, ...(yield* store.listPendingOps)];
        for (const message of page.messages)
          if (
            !pending.some(
              (op) => op.accountId === account.id && op.providerId === message.providerId,
            )
          )
            yield* store.upsertMessage(account.id, message);
      }),
    );
    return {
      ...page,
      ids: yield* Effect.forEach(page.messages.filter(eligibleForFilter), (message) =>
        store
          .messageIdForProvider(account.id, message.providerId)
          .pipe(Effect.map((id) => id ?? `${account.id}/${message.providerId}`)),
      ),
    };
  });
  const localOutlookPreview = Effect.fnUntraced(function* (
    accountId: string,
    email: string,
    criteria: FilterInput["criteria"],
    messageIds?: readonly string[],
  ) {
    const aliases = (yield* store.sendAs).filter((alias) => alias.accountId === accountId);
    const identities = aliases.length
      ? [email, ...aliases.map((alias) => alias.address)]
      : undefined;
    const unavailable = new Set(outlookPreviewUnavailable(criteria, identities !== undefined));
    if (unavailable.size) return { matches: [], unavailable: [...unavailable], truncated: false };
    const candidates = yield* store.listThreads({
      mailbox: "all",
      accountIds: [accountId],
      flat: true,
      ...(messageIds ? { messageIds } : {}),
      limit: 10001,
    });
    const matches: FilterPreview["matches"][number][] = [];
    for (const summary of candidates.filter(eligibleForFilter)) {
      const evaluation = evaluateOutlookRule(
        criteria,
        yield* store.getMessage(summary.id),
        identities,
      );
      for (const field of evaluation.unavailable) unavailable.add(field);
      if (evaluation.matches && !evaluation.unavailable.length) matches.push(summary);
    }
    return {
      matches: unavailable.size ? [] : matches.slice(0, 200),
      ...(unavailable.size ? { unavailable: [...unavailable] } : {}),
      truncated: candidates.length > 10000 || matches.length > 200,
    };
  });
  const previews = new Map<
    string,
    { accountId: string; input: string; ids: string[]; expires: number; unavailable: boolean }
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
    const labelsForRule = yield* store.listLabels([accountId]);
    if (unknownRuleLabel(input, labelsForRule))
      return yield* new InvalidInput({ message: "Choose a label or folder from this account" });
    return preview;
  });
  const prepareFilter = Effect.fnUntraced(function* (accountId: string, input: FilterInput) {
    const { account } = yield* owner(accountId);
    const invalid = validateFilter({ ...input, queryDeletionConfirmed: true }, account.provider);
    if (invalid) return yield* invalid;
    if (
      account.provider === "imap" ||
      (account.provider === "outlook" && (input.criteria.query || input.action.star))
    )
      return yield* new InvalidInput({ message: "Unsupported server rule" });
    const labelsForRule = yield* store.listLabels([accountId]);
    if (unknownRuleLabel(input, labelsForRule))
      return yield* new InvalidInput({ message: "Choose a label or folder from this account" });
    const preview = yield* Effect.gen(function* () {
      switch (account.provider) {
        case "outlook": {
          // KQL cannot represent arbitrary literal containment; search only supplies candidates.
          const unavailable = yield* localOutlookPreview(
            accountId,
            account.email,
            input.criteria,
            [],
          );
          if (unavailable.unavailable?.length) return unavailable;
          const page = yield* cacheSearchPage(account, {
            mailbox: "all",
            searchScope: "all",
            accountIds: [accountId],
            flat: true,
            limit: 201,
          });
          const result = yield* localOutlookPreview(
            accountId,
            account.email,
            input.criteria,
            page.ids,
          );
          return {
            ...result,
            truncated: result.truncated || page.truncated || page.messages.length > 200,
          };
        }
        case "gmail": {
          const page = yield* cacheSearchPage(account, {
            ...filterQuery(input.criteria),
            accountIds: [accountId],
            flat: true,
            limit: 201,
          });
          const matches = (yield* store.listThreads({
            mailbox: "all",
            accountIds: [accountId],
            flat: true,
            messageIds: page.ids.slice(0, 200),
            limit: 200,
          })).filter(eligibleForFilter);
          return { matches, truncated: page.truncated || page.messages.length > 200 };
        }
        case "imap":
          return yield* new InvalidInput({ message: "Unsupported server rule" });
        default: {
          const _exhaustive: never = account.provider;
          return _exhaustive;
        }
      }
    });
    const { matches } = preview;
    const token = crypto.randomUUID();
    const now = yield* Clock.currentTimeMillis;
    for (const [key, cached] of previews) if (cached.expires <= now) previews.delete(key);
    if (previews.size >= 50) {
      const oldest = previews.keys().next().value;
      if (oldest) previews.delete(oldest);
    }
    previews.set(token, {
      accountId,
      input: fingerprint(input),
      ids: matches.map((m) => m.id),
      unavailable: "unavailable" in preview && (preview.unavailable?.length ?? 0) > 0,
      expires: now + 5 * 60_000,
    });
    return {
      token,
      ...preview,
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
          const { account } = yield* owner(accountId);
          if (
            preview.unavailable ||
            (account.provider === "outlook" && outlookServerOnlyAction(input.action))
          )
            return yield* new InvalidInput({
              message: "This rule can only be applied to future mail on the server",
            });
          previews.delete(token);
          const ops: MailOp[] = [
            ...(input.action.markRead ? [{ kind: "read", value: true } satisfies MailOp] : []),
            ...(input.action.important !== undefined
              ? [{ kind: "important", value: input.action.important } satisfies MailOp]
              : []),
            ...labelOps(
              [
                ...(input.action.labels ?? []),
                ...(input.action.category ? [input.action.category] : []),
                ...(input.action.addLabelIds ?? []),
              ],
              true,
            ),
            ...labelOps(input.action.removeLabelIds ?? [], false),
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
    filters: (accountId) =>
      Effect.gen(function* () {
        const { account, adapter } = yield* owner(accountId);
        return yield* adapter.filters(account);
      }),
    previewFilter: (accountId, criteria) =>
      Effect.gen(function* () {
        const { account } = yield* owner(accountId);
        if (account.provider === "outlook" && criteria.exceptAttachment === false)
          return yield* new InvalidInput({ message: "Unsupported server rule" });
        if (account.provider === "outlook") {
          const preview = yield* localOutlookPreview(accountId, account.email, criteria);
          if (preview.unavailable?.length)
            return yield* new InvalidInput({
              message: "Some rule conditions cannot be evaluated from cached mail",
            });
          return preview.matches;
        }
        const query = { ...filterQuery(criteria), accountIds: [accountId], flat: true, limit: 200 };
        if (account.provider !== "gmail")
          return (yield* store.listThreads(query)).filter(eligibleForFilter);
        const page = yield* cacheSearchPage(account, query);
        return (yield* store.listThreads({
          mailbox: "all",
          flat: true,
          messageIds: page.ids,
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
  } satisfies Pick<
    Mailbox["Service"],
    | "prepareFilter"
    | "filterRestorations"
    | "prepareFilterRestoration"
    | "discardFilterRestoration"
    | "restoreFilter"
    | "updateFilter"
    | "applyFilter"
    | "filters"
    | "previewFilter"
    | "createFilter"
    | "deleteFilter"
  >;
}
