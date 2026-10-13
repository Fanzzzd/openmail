import { Effect } from "effect";
import type { Account } from "./domain/domain.js";
import { FeatureScopeMissing, InvalidInput, type ProviderFailure } from "./domain/errors.js";
import {
  FOLDER_BATCH_LIMIT,
  GMAIL_PERMANENT_DELETE_SCOPE,
  FOLDER_MESSAGE_LIMIT,
  SELECTED_DELETE_LIMIT,
  type FolderScope,
  type FolderPage,
  type FolderListOptions,
  type DeleteFolder,
} from "./domain/folder-actions.js";
import type { Mailbox } from "./mailbox.js";
import type { Providers, Store } from "./services.js";

const requireConfirmation = (confirmed: boolean) =>
  confirmed
    ? Effect.void
    : Effect.fail(new InvalidInput({ message: "Confirm permanent deletion in the app." }));

/** These operations are deliberately separate from commands available to agents. */
export function makeFolderMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  changed: Effect.Effect<void>,
  protect: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
) {
  const isEnabled = (account: Account) =>
    store.getAccount(account.id).pipe(Effect.map((current) => current.enabled !== false));
  const providerCall = <A>(
    account: Account,
    effect: Effect.Effect<A, ProviderFailure | FeatureScopeMissing | InvalidInput>,
  ) =>
    effect.pipe(
      Effect.tapError((error) =>
        error._tag === "AuthError"
          ? store.markReauth(account.id, error).pipe(Effect.andThen(changed))
          : error._tag === "FeatureScopeMissing" && error.feature === "permanentDelete"
            ? store.grantedScopes(account.id).pipe(
                Effect.flatMap((scopes) =>
                  store.setGrantedScopes(
                    account.id,
                    scopes.filter((scope) => scope !== GMAIL_PERMANENT_DELETE_SCOPE),
                  ),
                ),
              )
            : Effect.void,
      ),
    );
  const audit = (accountId: string, action: string, count: number) =>
    store.appendAudit({
      actor: { kind: "user", surface: "app" },
      accountId,
      action,
      detail: { count },
    });
  const requireDeleteScopes = (accounts: readonly Account[]) =>
    Effect.forEach(
      accounts,
      (account) =>
        Effect.gen(function* () {
          if (!(yield* isEnabled(account))) return;
          if (
            account.provider === "gmail" &&
            !(yield* store.grantedScopes(account.id)).includes(GMAIL_PERMANENT_DELETE_SCOPE)
          )
            yield* new FeatureScopeMissing({
              accountId: account.id,
              feature: "permanentDelete",
              message: "Authorize permission to permanently delete mail in this Gmail account.",
            });
        }),
      { discard: true },
    );
  const ready = (accountIds: readonly string[]) =>
    Effect.gen(function* () {
      if (
        (yield* store.listPendingOps).some(
          (op) => op.op.kind !== "reconcile" && accountIds.includes(op.accountId),
        )
      )
        yield* new InvalidInput({
          message: "Wait for pending changes to sync before changing the folder.",
        });
    });
  const requireDeleteCapabilities = (accounts: readonly Account[], folder: DeleteFolder) =>
    Effect.forEach(accounts, (account) =>
      Effect.gen(function* () {
        if (!(yield* isEnabled(account))) return null;
        const labels = yield* providerCall(
          account,
          providers.get(account.provider).checkPermanentDelete(account, folder),
        );
        return { account, labels };
      }),
    ).pipe(Effect.map((plans) => plans.filter((plan) => plan !== null)));
  const folderPage = (
    account: Account,
    folder: FolderScope,
    cursor: string | null,
    options: FolderListOptions,
  ) =>
    protect(
      Effect.gen(function* () {
        if (!(yield* isEnabled(account))) return { ids: [], next: null } satisfies FolderPage;
        return yield* providerCall(
          account,
          providers.get(account.provider).listFolderMessages(account, folder, cursor, options),
        );
      }),
    );
  const snapshot = (account: Account, folder: FolderScope) =>
    Effect.gen(function* () {
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: FolderPage = yield* folderPage(account, folder, cursor, { unreadOnly: true });
        for (const id of page.ids) ids.add(id);
        if (ids.size > FOLDER_MESSAGE_LIMIT)
          return yield* new InvalidInput({
            message: "The folder exceeds the operation limit of 100,000 messages.",
          });
        cursor = page.next;
        if (cursor !== null) {
          if (cursors.has(cursor))
            return yield* new InvalidInput({ message: "Folder pagination repeated a page." });
          cursors.add(cursor);
        }
      } while (cursor !== null);
      return [...ids];
    });
  const remove = (
    account: Account,
    ids: readonly string[],
    folder: DeleteFolder,
    folderLabels: readonly string[],
  ) =>
    Effect.gen(function* () {
      let removed = 0;
      const size = FOLDER_BATCH_LIMIT;
      for (let start = 0; start < ids.length; start += size) {
        const batch = ids.slice(start, start + size);
        yield* protect(
          Effect.gen(function* () {
            if (!(yield* isEnabled(account))) return yield* Effect.void;
            yield* ready([account.id]);
            const eligible = (yield* Effect.forEach(batch, (id) =>
              Effect.gen(function* () {
                if (
                  (yield* store.messageIdForProvider(account.id, id)) &&
                  !(yield* store.messageLabels(account.id, id)).some((label) =>
                    folderLabels.includes(label),
                  )
                )
                  return null;
                return id;
              }),
            )).filter((id) => id !== null);
            if (!eligible.length) return yield* Effect.void;
            const result = yield* providerCall(
              account,
              providers.get(account.provider).permanentlyDelete(account, eligible, folder),
            );
            if (result.ids.length) {
              yield* store.transaction(
                Effect.forEach(result.ids, (id) => store.deleteMessage(account.id, id), {
                  discard: true,
                }),
              );
              removed += result.ids.length;
              yield* audit(account.id, "permanentlyDelete", result.ids.length);
              yield* changed;
            }
            if (result.kind === "partial")
              return yield* providerCall(account, Effect.fail(result.error));
            return yield* Effect.void;
          }),
        );
        yield* Effect.yieldNow;
      }
      return removed;
    });
  const permanentlyDelete: Mailbox["Service"]["permanentlyDelete"] = (
    threads,
    flat,
    folder,
    confirmed,
  ) =>
    Effect.gen(function* () {
      yield* requireConfirmation(confirmed);
      if (!threads.length || threads.length > SELECTED_DELETE_LIMIT)
        return yield* new InvalidInput({ message: "Select between 1 and 1,000 conversations." });
      const grouped = new Map<string, Set<string>>();
      for (const thread of new Set(threads)) {
        const ids = flat ? [thread] : yield* store.threadMessageIds(thread);
        if (!ids.length)
          return yield* new InvalidInput({
            message: "The selected conversation is no longer available.",
          });
        for (const id of ids) {
          const ref = yield* store.messageRef(id);
          const group = grouped.get(ref.accountId) ?? new Set<string>();
          group.add(ref.providerId);
          grouped.set(ref.accountId, group);
        }
      }
      const count = [...grouped.values()].reduce((n, ids) => n + ids.size, 0);
      if (count > FOLDER_MESSAGE_LIMIT)
        return yield* new InvalidInput({ message: "The selection exceeds 100,000 messages." });
      const accounts = (yield* Effect.forEach([...grouped.keys()], (id) =>
        store.getAccount(id),
      )).filter((account) => account.enabled !== false);
      yield* protect(ready(accounts.map((account) => account.id)));
      yield* requireDeleteScopes(accounts);
      const plans = yield* requireDeleteCapabilities(accounts, folder);
      let removed = 0;
      for (const { account, labels } of plans)
        removed += yield* remove(account, [...(grouped.get(account.id) ?? [])], folder, labels);
      return removed;
    });
  const folderAction = (folder: FolderScope, destructive: boolean, confirmed: boolean) =>
    Effect.gen(function* () {
      if (destructive) {
        yield* requireConfirmation(confirmed);
        if (folder.label !== undefined || !["trash", "spam"].includes(folder.mailbox))
          return yield* new InvalidInput({ message: "Only Trash or Spam can be emptied." });
      }
      if (folder.mailbox === "snoozed")
        return yield* new InvalidInput({ message: "Choose a server folder." });
      const accounts = (yield* store.listAccounts).filter(
        (a) => a.enabled !== false && (!folder.accountIds || folder.accountIds.includes(a.id)),
      );
      yield* protect(ready(accounts.map((a) => a.id)));
      if (destructive) {
        yield* requireDeleteScopes(accounts);
        const target = folder.mailbox === "trash" ? "trash" : "spam";
        const plans = yield* requireDeleteCapabilities(accounts, target);
        let count = 0;
        for (const { account, labels } of plans) {
          const pages = new Set<string>();
          for (;;) {
            const page = yield* folderPage(account, folder, null, { includeChildren: true });
            if (!page.ids.length) break;
            const signature = JSON.stringify([...new Set(page.ids)].toSorted());
            if (pages.has(signature))
              return yield* new InvalidInput({
                message: "Folder deletion repeated the same messages. Refresh and try again.",
              });
            pages.add(signature);
            if (
              page.ids.length > FOLDER_BATCH_LIMIT ||
              count + page.ids.length > FOLDER_MESSAGE_LIMIT
            )
              return yield* new InvalidInput({
                message: "The folder exceeds the operation limit of 100,000 messages.",
              });
            count += yield* remove(account, page.ids, target, labels);
          }
        }
        return count;
      }
      // Capture unread IDs before mutation, avoiding unread offset pagination skips.
      const plans = yield* Effect.forEach(accounts, (account) =>
        snapshot(account, folder).pipe(Effect.map((ids) => ({ account, ids }))),
      );
      if (plans.reduce((n, plan) => n + plan.ids.length, 0) > FOLDER_MESSAGE_LIMIT)
        return yield* new InvalidInput({
          message: "The folder exceeds the operation limit of 100,000 messages.",
        });
      let count = 0;
      for (const { account, ids } of plans) {
        const size = account.provider === "outlook" ? 20 : FOLDER_BATCH_LIMIT;
        for (let start = 0; start < ids.length; start += size) {
          const batch = ids.slice(start, start + size);
          const op = { kind: "read", value: true } as const;
          const applied = yield* protect(
            Effect.gen(function* () {
              if (!(yield* isEnabled(account))) return false;
              yield* ready([account.id]);
              yield* providerCall(
                account,
                providers.get(account.provider).markReadBatch(account, batch),
              );
              yield* store.transaction(
                Effect.forEach(
                  batch,
                  (id) =>
                    store
                      .messageIdForProvider(account.id, id)
                      .pipe(
                        Effect.flatMap((local) =>
                          local ? store.applyLocalOp(local, op) : Effect.void,
                        ),
                      ),
                  {
                    discard: true,
                  },
                ),
              );
              yield* audit(account.id, "markFolderRead", batch.length);
              yield* changed;
              return true;
            }),
          );
          if (!applied) break;
          count += batch.length;
          yield* Effect.yieldNow;
        }
      }
      return count;
    });
  const resetFavorites: Mailbox["Service"]["resetFavorites"] = (accountIds) =>
    store
      .transaction(
        Effect.gen(function* () {
          for (const id of accountIds) yield* store.getAccount(id);
          for (const pref of yield* store.labelPreferences) {
            if (accountIds.includes(pref.accountId) && pref.favorite)
              yield* store.setLabelPreference({ ...pref, favorite: false });
          }
        }),
      )
      .pipe(Effect.tap(() => changed));
  return {
    permanentlyDelete,
    emptyFolder: (folder: FolderScope, confirmed: boolean) => folderAction(folder, true, confirmed),
    markFolderRead: (folder: FolderScope) => folderAction(folder, false, false),
    resetFavorites,
  };
}
