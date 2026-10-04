import { Clock, Effect, Option, Queue, Schema, Stream } from "effect";
import { HttpClientRequest } from "effect/http";
import { categoryKey, mergeCategoryNames } from "../categories.js";
import type { Account, Attachment, IncomingMessage, MailOp } from "../domain.js";
import { AuthError, PermanentError, ProviderError, type ProviderFailure } from "../errors.js";
import { FOLDER_BATCH_LIMIT, type PermanentDeleteBatch } from "../folder-actions.js";
import type { CachedHeaders } from "../header-backfill.js";
import { stripMessageIdBrackets } from "../message-id.js";
import { makeOutlookFeatures } from "../outlook-features.js";
import { makeOutlookSettings } from "../outlook-settings.js";
import { hasSignedContainer } from "../platform/mime-compat.js";
import { BatchResponse, batchThrottleDelay, verifyInChunks } from "../provider-batch.js";
import { makeProviderCalendar } from "../provider-calendar.js";
import { BackgroundRead } from "../provider-connectivity.js";
import { logInvalidGraphCursor } from "../provider-diagnostics.js";
import { ApiError } from "../provider-http.js";
import { graphPages } from "../provider-pages.js";
import { retryProvider, uncertainWrite } from "../provider-retry.js";
import { graphSearch, matchesSearch, parseSearchQuery, searchMailboxLabel } from "../search.js";
import { type Change, type ProviderAdapter } from "../services.js";
import type { FolderStatus } from "../sync-health.js";
import { logSyncReset, type ResetVerification } from "../sync-reset.js";
import type { GraphClient } from "./client.js";
import {
  AttachmentList,
  CONCURRENCY,
  decode,
  decodeCursor,
  destination,
  EXPAND_ATTACHMENTS,
  FolderPage,
  GRAPH,
  GraphMessage,
  ID_TYPE_KEY,
  INITIAL_WINDOW_DAYS,
  is404,
  is410,
  isTransient,
  MESSAGE_SELECT,
  nextPage,
  PREFER,
  readFailure,
  SearchRequest,
  SELECT,
  SKIPPED,
  type SyncFolder,
  WELL_KNOWN,
  WINDOW_KEY,
  WithId,
  writeFailure,
} from "./graph.js";
import type { OutlookParser } from "./parse.js";
import { expandedAttachments, parseGraphMessage } from "./parse.js";

export const makeOutlookSync = (client: GraphClient, parser: OutlookParser) =>
  Effect.sync(() => {
    const { connectivity, readRetryAt, api, get, getDelta, write, deleteFolderIds, connect } =
      client;
    const { incomingGraph } = parser;
    // Server writes are authoritative while Graph folder listings catch up.
    const pendingFolders = new Map<
      string,
      Map<string, { name: string | null; previousName?: string }>
    >();

    const rememberFolder = (
      accountId: string,
      id: string,
      change: { name: string | null; previousName?: string },
    ) => {
      let pending = pendingFolders.get(accountId);
      if (!pending) {
        pending = new Map();
        pendingFolders.set(accountId, pending);
      }
      pending.set(id, change);
    };

    const mergeFolderChanges = (
      accountId: string,
      listedFolders: readonly { id: string; name: string }[],
      confirmed: boolean,
    ) => {
      const pending = pendingFolders.get(accountId);
      if (!pending) return listedFolders;
      const folders = new Map(listedFolders.map((folder) => [folder.id, folder]));
      for (const [id, change] of pending) {
        const listed = folders.get(id);
        if (confirmed && ((change.name === null && !listed) || listed?.name === change.name)) {
          pending.delete(id);
          continue;
        }
        if (change.name === null) {
          folders.delete(id);
          if (listed)
            for (const [childId, child] of folders)
              if (child.name.startsWith(`${listed.name}/`)) folders.delete(childId);
        } else {
          folders.set(id, { id, name: change.name });
          if (change.previousName)
            for (const [childId, child] of folders)
              if (child.name.startsWith(`${change.previousName}/`))
                folders.set(childId, {
                  ...child,
                  name: `${change.name}${child.name.slice(change.previousName.length)}`,
                });
        }
      }
      if (!pending.size) pendingFolders.delete(accountId);
      return [...folders.values()];
    };

    /**
     * User folders, nested names joined with "/". Skipped system folders are left
     * out together with their subfolders (Sync Issues holds Conflicts and so on),
     * including empty folders so newly created folders can be organized.
     */
    const listCustomFolders = Effect.fnUntraced(function* (accountId: string) {
      const systemIds = yield* Effect.forEach(
        [...WELL_KNOWN.map((f) => f.name), ...SKIPPED],
        (name) =>
          get(accountId, WithId, `/me/mailFolders/${encodeURIComponent(name)}?$select=id`).pipe(
            Effect.map(({ id }) => Option.some({ name, id })),
            // Not every mailbox has every well-known folder.
            Effect.catchIf(is404, () => Effect.succeed(Option.none())),
          ),
        { concurrency: 4 },
      );
      const system = new Set<string>();
      const skipped = new Set<string>();
      for (const found of systemIds) {
        if (Option.isNone(found)) continue;
        system.add(found.value.id);
        if (SKIPPED.includes(found.value.name)) skipped.add(found.value.id);
      }

      const out: { id: string; name: string }[] = [];
      const seenFolders = new Set<string>();
      const walk = (
        path: string,
        prefix: string,
      ): Effect.Effect<void, ApiError | AuthError | ProviderError> =>
        Effect.gen(function* () {
          let url: string | undefined =
            `${path}?$select=id,displayName,childFolderCount,totalItemCount&$top=100&includeHiddenFolders=false`;
          const seen = new Set<string>();
          for (const loadPage of graphPages(
            url,
            (pagePath) =>
              Effect.gen(function* () {
                return yield* get(accountId, FolderPage, pagePath);
              }),
            () => url,
          )) {
            const page: typeof FolderPage.Type = yield* loadPage;

            for (const f of page.value) {
              if (skipped.has(f.id)) continue;
              if (seenFolders.has(f.id))
                return yield* new ProviderError({
                  message: "Mail folder hierarchy repeated a folder",
                });
              seenFolders.add(f.id);
              const name = prefix ? `${prefix}/${f.displayName}` : f.displayName;
              if (!system.has(f.id)) out.push({ id: f.id, name });
              if (f.childFolderCount > 0)
                yield* walk(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders`, name);
            }
            const next = page["@odata.nextLink"];
            url = next
              ? yield* nextPage(
                  next,
                  path,
                  seen,
                  () => new ProviderError({ message: "Invalid mail folder pagination link" }),
                )
              : undefined;
          }
          return yield* Effect.void;
        });
      yield* walk("/me/mailFolders", "");
      return mergeFolderChanges(accountId, out, true);
    });

    /**
     * Follows a folder's delta from `start` (an initial delta URL or a stored
     * deltaLink) to the end, collecting changed messages and removed ids. The
     * final deltaLink is the cursor for the next sync.
     */

    const fetchAttachments = (accountId: string, id: string) =>
      get(
        accountId,
        AttachmentList,
        `/me/messages/${encodeURIComponent(id)}/attachments?$select=name,contentType,size,isInline`,
      ).pipe(
        // Inline parts are embedded images (signatures, tracking), not real files.
        Effect.map(({ value }): Attachment[] =>
          value
            .filter((a) => !a.isInline)
            .map((a) => ({ filename: a.name, mimeType: a.contentType, size: a.size })),
        ),
      );

    const pull = (
      account: Account,
      cursor: Option.Option<string>,
      scope?: "inbox",
      incrementalOnly = false,
    ): Stream.Stream<Change, ProviderFailure> =>
      Stream.callback<Change, ProviderFailure>(
        (queue) =>
          Effect.gen(function* () {
            const stored: Readonly<Record<string, string>> = Option.getOrElse(
              Option.flatMap(cursor, decodeCursor),
              () => ({}),
            );
            const reset = stored[ID_TYPE_KEY] !== "immutable";
            const previous = reset ? {} : stored;
            const since = (yield* Clock.currentTimeMillis) - INITIAL_WINDOW_DAYS * 86400000;
            const custom = scope ? [] : yield* listCustomFolders(account.id);
            const folders: SyncFolder[] = [
              ...WELL_KNOWN.filter((f) => !scope || f.name === "inbox").map((f) => ({
                key: f.name,
                path: f.name,
                label: f.label,
              })),
              ...custom.map((f) => ({ key: f.id, path: f.id, label: f.id })),
            ];
            let started = false;
            const start = Effect.gen(function* () {
              if (started) return;
              started = true;
              if (!scope)
                yield* Queue.offer(queue, {
                  _tag: "Labels",
                  labels: custom.map((f) => ({ id: f.id, name: f.name, color: null })),
                });
            });
            // Only identities cross page boundaries. Full Graph bodies belong to one
            // page, with backpressure from the bounded sync queue.
            const kept = new Set<string>();
            const restarted = new Set<string>();
            const removed = new Map<string, Set<string>>();
            const changedFolders = new Map<string, Set<string>>();
            const next: Record<string, string> = {
              [ID_TYPE_KEY]: "immutable",
              ...(stored[WINDOW_KEY] ? { [WINDOW_KEY]: stored[WINDOW_KEY] } : {}),
            };
            let fetched = 0;
            for (const folder of folders) {
              let known = previous[folder.key];
              if (incrementalOnly && known === undefined)
                yield* new ProviderError({
                  message: "Foreground sync required to renew the cursor",
                });
              // Delta's filtered snapshot can cap at 5,000. Its keep set never covers older headers.
              const initial = `${GRAPH}/me/mailFolders/${encodeURIComponent(folder.path)}/messages/delta?$select=${SELECT}&${EXPAND_ATTACHMENTS}&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(since).toISOString()}`)}&$orderby=receivedDateTime%20desc`;
              const deltaBase = `/me/mailFolders/${encodeURIComponent(folder.path)}/messages/delta`;
              const seen = new Set<string>();
              const validateDelta = (link: string) =>
                nextPage(
                  link,
                  deltaBase,
                  seen,
                  () => new ProviderError({ message: "Invalid or repeated Graph delta link" }),
                );
              const firstUrl = yield* validateDelta(known ?? initial).pipe(
                Effect.catch((failure) =>
                  known === undefined
                    ? Effect.fail(failure)
                    : Effect.gen(function* () {
                        yield* logInvalidGraphCursor(account.id);
                        known = undefined;
                        restarted.add(folder.label);
                        seen.clear();
                        return yield* validateDelta(initial);
                      }),
                ),
              );
              const first = yield* getDelta(account.id, firstUrl).pipe(
                Effect.map(Option.some),
                Effect.catchIf(
                  (e) => known === undefined && is404(e),
                  () => Effect.succeed(Option.none()),
                ),
                Effect.catchIf(
                  (e) => !incrementalOnly && known !== undefined && is410(e),
                  () =>
                    Effect.gen(function* () {
                      seen.clear();
                      const fresh = yield* getDelta(account.id, yield* validateDelta(initial));
                      yield* start;
                      restarted.add(folder.label);
                      return Option.some(fresh);
                    }),
                ),
              );
              if (Option.isNone(first)) continue;
              if (reset || known === undefined || restarted.has(folder.label))
                next[WINDOW_KEY] = String(INITIAL_WINDOW_DAYS);
              yield* start;
              let page = first.value;
              const listed = new Set<string>();
              const folderKept = new Set<string>();
              let deferredFetches = 0;
              let pageUrl: string | undefined = firstUrl;
              let firstPage = true;
              for (const loadPage of graphPages(
                firstUrl,
                (url) =>
                  Effect.suspend(() => {
                    if (!firstPage) return getDelta(account.id, url);
                    firstPage = false;
                    return Effect.succeed(first.value);
                  }),
                () => pageUrl,
              )) {
                page = yield* loadPage;
                const total = fetched + page.value.filter((item) => !("@removed" in item)).length;
                yield* Stream.fromIterable(page.value).pipe(
                  Stream.mapEffect(
                    (item) =>
                      Effect.gen(function* () {
                        if ("@removed" in item) {
                          if (!reset && !restarted.has(folder.label)) {
                            const labels = removed.get(item.id) ?? new Set<string>();
                            labels.add(folder.label);
                            removed.set(item.id, labels);
                          }
                          return null;
                        }
                        // Listing proves presence even when a later body GET returns 404.
                        listed.add(item.id);
                        kept.add(item.id);
                        const labels = changedFolders.get(item.id) ?? new Set<string>();
                        labels.add(folder.label);
                        changedFolders.set(item.id, labels);
                        folderKept.add(item.id);
                        const message =
                          "conversationId" in item
                            ? Option.some(item)
                            : yield* get(
                                account.id,
                                GraphMessage,
                                `/me/messages/${encodeURIComponent(item.id)}?$select=${MESSAGE_SELECT}&${EXPAND_ATTACHMENTS}`,
                              ).pipe(
                                Effect.map(Option.some),
                                Effect.catchIf(is404, () => Effect.succeed(Option.none())),
                              );
                        if (Option.isNone(message)) {
                          deferredFetches++;
                          return { _tag: "FetchLater", providerId: item.id } satisfies Change;
                        }
                        const raw = message.value;
                        const attachments =
                          expandedAttachments(raw) ??
                          (raw.hasAttachments ? yield* fetchAttachments(account.id, raw.id) : []);
                        kept.add(raw.id);
                        return {
                          _tag: "Upsert",
                          message: yield* incomingGraph(account, raw, folder.label, attachments),
                        } satisfies Change;
                      }),
                    { concurrency: CONCURRENCY },
                  ),
                  Stream.runForEach((change) =>
                    Effect.gen(function* () {
                      if (!change) return;
                      yield* Queue.offer(queue, change);
                      yield* Queue.offer(queue, { _tag: "Progress", fetched: ++fetched, total });
                    }),
                  ),
                );
                if (page["@odata.deltaLink"])
                  next[folder.key] = yield* nextPage(
                    page["@odata.deltaLink"],
                    deltaBase,
                    undefined,
                    () => new ProviderError({ message: "Invalid Graph delta bookmark" }),
                  );
                const url = page["@odata.nextLink"];
                pageUrl = url ? yield* validateDelta(url) : undefined;
              }
              if (!next[folder.key] && known !== undefined) next[folder.key] = known;
              if (reset || known === undefined || restarted.has(folder.label))
                yield* logSyncReset(account, folder.label, {
                  phase: "listing",
                  listed: listed.size,
                  kept: folderKept.size,
                  local: 0,
                  candidates: 0,
                  verified: 0,
                  incomplete: deferredFetches + (page["@odata.deltaLink"] ? 0 : 1),
                  deferred: deferredFetches,
                });
            }
            // Changes from removed folders can overwrite a move observed earlier.
            // Resolve overlaps after all pages, through the durable verification queue.
            yield* start;
            const keep = [...kept];
            if (reset) yield* Queue.offer(queue, { _tag: "Reset", keep, since, partial: true });
            else
              for (const label of restarted)
                yield* Queue.offer(queue, {
                  _tag: "DeleteLabel",
                  label,
                  keep,
                  since,
                  partial: true,
                });
            const ambiguous: string[] = [];
            for (const [providerId, removedLabels] of removed) {
              if (!kept.has(providerId)) yield* Queue.offer(queue, { _tag: "Delete", providerId });
              else if (
                [...(changedFolders.get(providerId) ?? [])].some((label) =>
                  removedLabels.has(label),
                )
              )
                ambiguous.push(providerId);
            }
            // Delta may repeat an identity across pages. An update does not prove
            // presence after a removal from the same folder; verify its current location.
            if (!scope && ambiguous.length)
              yield* Queue.offer(queue, { _tag: "VerifyCandidates", providerIds: ambiguous });
            const wellKnown = new Set(WELL_KNOWN.map((f) => f.name));
            for (const key of Object.keys(previous)) {
              if (key === ID_TYPE_KEY || key === WINDOW_KEY || wellKnown.has(key) || key in next)
                continue;
              // Visible folder lists omit hidden folders. Only a direct 404 establishes removal.
              const gone = yield* get(
                account.id,
                WithId,
                `/me/mailFolders/${encodeURIComponent(key)}?$select=id`,
              ).pipe(
                Effect.map(() => false),
                Effect.catch((error) => Effect.succeed(is404(error))),
              );
              if (gone)
                yield* Queue.offer(queue, { _tag: "DeleteLabel", label: key, partial: true });
              else {
                const saved = previous[key];
                if (saved !== undefined) next[key] = saved;
              }
            }
            yield* Queue.offer(queue, { _tag: "Cursor", cursor: JSON.stringify(next) });
            yield* Queue.end(queue);
          }).pipe(
            Effect.withSpan("Outlook.pull"),
            Effect.mapError(readFailure(account.id)),
            Effect.catchCause((cause) => Queue.failCause(queue, cause)),
          ),
        { bufferSize: 16, strategy: "suspend" },
      );

    const push = Effect.fn("Outlook.push")(
      function* (account: Account, providerId: string, op: MailOp) {
        if (op.kind === "copy")
          yield* new PermanentError({
            message: "Folder copies are available for IMAP accounts.",
          });
        const path = `/me/messages/${encodeURIComponent(providerId)}`;
        if (op.kind === "read") {
          yield* write(account.id, "PATCH", path, { isRead: op.value });
          return;
        }
        if (op.kind === "important") {
          yield* write(account.id, "PATCH", path, { importance: op.value ? "high" : "normal" });
          return;
        }
        if (op.kind === "star") {
          yield* write(account.id, "PATCH", path, {
            flag: { flagStatus: op.value ? "flagged" : "notFlagged" },
          });
          return;
        }
        if (op.kind === "categories") {
          const current = yield* get(
            account.id,
            Schema.Struct({ categories: Schema.optionalKey(Schema.Array(Schema.String)) }),
            `${path}?$select=categories`,
          );
          const Page = Schema.Struct({
            value: Schema.Array(Schema.Struct({ displayName: Schema.String })),
            "@odata.nextLink": Schema.optionalKey(Schema.String),
          });
          const registered = new Map<string, string>();
          let next: string | undefined = "/me/outlook/masterCategories?$select=displayName";
          const seen = new Set<string>();
          for (const loadPage of graphPages(
            next,
            (pagePath) =>
              Effect.gen(function* () {
                if (seen.has(pagePath) || seen.size >= 100)
                  yield* new PermanentError({
                    message: "Category pagination repeated or exceeded its limit.",
                  });
                seen.add(pagePath);

                return yield* get(account.id, Page, pagePath);
              }),
            () => next,
          )) {
            const page: typeof Page.Type = yield* loadPage;

            for (const category of page.value)
              registered.set(categoryKey(category.displayName), category.displayName);
            next = page["@odata.nextLink"]
              ? yield* nextPage(
                  page["@odata.nextLink"],
                  "/me/outlook/masterCategories",
                  undefined,
                  () => new PermanentError({ message: "Invalid category pagination URL." }),
                )
              : undefined;
          }
          const additions: string[] = [];
          for (const name of mergeCategoryNames([], op.add, [])) {
            const key = categoryKey(name);
            if (!registered.has(key)) {
              const created = yield* write(account.id, "POST", "/me/outlook/masterCategories", {
                displayName: name,
                color: "none",
              }).pipe(Effect.flatMap(decode(Schema.Struct({ displayName: Schema.String }))));
              registered.set(key, created.displayName);
            }
            additions.push(registered.get(key) ?? name);
          }
          yield* write(account.id, "PATCH", path, {
            categories: mergeCategoryNames(current.categories ?? [], additions, op.remove),
          });
          return;
        }
        const destinationId = destination(op);
        if (destinationId) yield* write(account.id, "POST", `${path}/move`, { destinationId });
      },
      (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
    );

    const settings = makeOutlookSettings(get, write);

    const changeLabel: ProviderAdapter["changeLabel"] = (account, change) =>
      Effect.gen(function* () {
        const before = yield* listCustomFolders(account.id);
        if (change.kind === "create") {
          const parent = before.find((f) => f.id === change.parentId);
          const name = `${parent ? `${parent.name}/` : ""}${change.name}`;
          const result = yield* write(
            account.id,
            "POST",
            change.parentId
              ? `/me/mailFolders/${encodeURIComponent(change.parentId)}/childFolders`
              : "/me/mailFolders",
            { displayName: change.name },
          ).pipe(
            Effect.catchIf(
              (error) =>
                error._tag === "ApiError" && (error.status === 409 || uncertainWrite(error)),
              (error) =>
                Effect.gen(function* () {
                  const folders = yield* listCustomFolders(account.id);
                  const found = folders.find(
                    (folder) => folder.name.toLowerCase() === name.toLowerCase(),
                  );
                  if (!found) return yield* Effect.fail(error);
                  return { id: found.id, displayName: change.name };
                }),
            ),
          );
          const folder = yield* decode(
            Schema.Struct({ id: Schema.String, displayName: Schema.optionalKey(Schema.String) }),
          )(result);
          rememberFolder(account.id, folder.id, {
            name: `${parent ? `${parent.name}/` : ""}${folder.displayName ?? change.name}`,
          });
        } else if (change.kind === "rename") {
          const old = before.find((f) => f.id === change.id);
          const result = yield* write(
            account.id,
            "PATCH",
            `/me/mailFolders/${encodeURIComponent(change.id)}`,
            { displayName: change.name },
          );
          const folder = yield* decode(
            Schema.Struct({ id: Schema.String, displayName: Schema.optionalKey(Schema.String) }),
          )(result);
          const prefix = old?.name.slice(0, old.name.lastIndexOf("/") + 1) ?? "";
          rememberFolder(account.id, folder.id, {
            name: `${prefix}${folder.displayName ?? change.name}`,
            ...(old ? { previousName: old.name } : {}),
          });
        } else if (change.kind === "parent") {
          const old = before.find((f) => f.id === change.id);
          const result = yield* write(
            account.id,
            "POST",
            `/me/mailFolders/${encodeURIComponent(change.id)}/move`,
            { destinationId: change.parentId ?? "msgfolderroot" },
          );
          const folder = yield* decode(WithId)(result);
          const parent = before.find((f) => f.id === change.parentId);
          if (old)
            rememberFolder(account.id, folder.id, {
              name: `${parent ? `${parent.name}/` : ""}${old.name.split("/").at(-1)}`,
              previousName: old.name,
            });
          if (folder.id !== change.id) rememberFolder(account.id, change.id, { name: null });
        } else if (change.kind === "delete") {
          yield* write(account.id, "DELETE", `/me/mailFolders/${encodeURIComponent(change.id)}`);
          rememberFolder(account.id, change.id, { name: null });
        }
        return mergeFolderChanges(account.id, before, false).map((f) => ({ ...f, color: null }));
      }).pipe(Effect.mapError(writeFailure(account.id)));

    const search: ProviderAdapter["search"] = (account, query) =>
      Effect.gen(function* () {
        const folders = yield* listCustomFolders(account.id);
        const system = yield* Effect.forEach(WELL_KNOWN, (f) =>
          get(account.id, WithId, `/me/mailFolders/${f.name}?$select=id`).pipe(
            Effect.map((r) => ({ id: r.id, label: f.label })),
            Effect.catchIf(is404, () => Effect.succeed({ id: f.name, label: f.label })),
          ),
        );
        const folderNames = folders.map((f) => ({ ...f, color: null }));
        const scope = searchMailboxLabel(query) ?? parseSearchQuery(query).criteria?.labels?.[0];
        const known = WELL_KNOWN.find((f) => f.label === scope)?.name;
        const folder =
          known ?? (scope && folders.find((f) => f.id === scope || f.name === scope)?.id);
        const base = folder
          ? `/me/mailFolders/${encodeURIComponent(folder)}/messages`
          : "/me/messages";
        const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
        const kql = graphSearch(query);
        const params = new URLSearchParams({
          $select: `${SELECT},parentFolderId`,
          $expand: "attachments($select=name,contentType,size,isInline)",
          $top: "100",
        });
        const messageId = parseSearchQuery(query).criteria?.rfcMessageId;
        if (messageId)
          params.set(
            "$filter",
            `internetMessageId eq '${`<${stripMessageIdBrackets(messageId)}>`.replaceAll("'", "''")}'`,
          );
        else if (kql) params.set("$search", JSON.stringify(kql));
        const messages: IncomingMessage[] = [];
        let url: string | undefined = `${base}?${params.toString()}`;
        let scanned = 0;
        const seen = new Set<string>();
        for (const loadPage of graphPages(
          url,
          (pagePath) =>
            Effect.gen(function* () {
              return yield* get(
                account.id,
                Schema.Struct({
                  value: Schema.Array(GraphMessage),
                  "@odata.nextLink": Schema.optionalKey(Schema.String),
                }),
                pagePath,
              );
            }),
          () => url,
        )) {
          const page: {
            readonly value: readonly GraphMessage[];
            readonly "@odata.nextLink"?: string;
          } = yield* loadPage;

          let consumed = 0;
          for (const raw of page.value) {
            scanned++;
            consumed++;
            const label =
              system.find((f) => f.id === raw.parentFolderId)?.label ??
              folders.find((f) => f.id === raw.parentFolderId)?.id;
            if (!label) continue;
            const attachments = expandedAttachments(raw) ?? [];
            const parsed = parseGraphMessage(raw, label, attachments);
            const message: IncomingMessage = {
              ...parsed,
              bodyCached:
                !(raw.hasAttachments && raw.attachments === undefined) &&
                !hasSignedContainer(parsed),
            };
            if (matchesSearch(message, query, folderNames)) messages.push(message);
            if (messages.length >= limit) break;
          }
          url = page["@odata.nextLink"]
            ? yield* nextPage(
                page["@odata.nextLink"],
                base,
                seen,
                () => new ProviderError({ message: "Invalid or repeated Graph search link" }),
              )
            : undefined;
          if (messages.length >= limit && consumed < page.value.length)
            return { messages, truncated: true };

          if (!(scanned < 1000 && messages.length < limit)) break;
        }
        return { messages, truncated: url !== undefined || scanned >= 1000 };
      }).pipe(
        Effect.mapError((error) => {
          const failure = readFailure(account.id)(error);
          return failure._tag === "AuthError"
            ? failure
            : new ProviderError({
                ...Schema.encodeSync(ProviderError)(failure),
                message: "The server could not complete this search.",
              });
        }),
        Effect.provideService(SearchRequest, true),
      );

    const pageSchema = Schema.Struct({
      value: Schema.Array(WithId),
      "@odata.nextLink": Schema.optionalKey(Schema.String),
    });

    const messageLabel = Effect.fnUntraced(function* (account: Account, raw: GraphMessage) {
      const system = yield* Effect.forEach(WELL_KNOWN, (f) =>
        get(account.id, WithId, `/me/mailFolders/${f.name}?$select=id`).pipe(
          Effect.map((r) => ({ id: r.id, label: f.label })),
          Effect.catchIf(is404, () => Effect.succeed({ id: f.name, label: f.label })),
        ),
      );
      return (
        system.find((f) => f.id === raw.parentFolderId)?.label ?? raw.parentFolderId ?? "ARCHIVE"
      );
    });

    const backfill: ProviderAdapter["backfill"] = (account, state, select) =>
      Effect.gen(function* () {
        const params = new URLSearchParams({
          $select: "id,receivedDateTime",
          $top: "50",
          $orderby: "receivedDateTime desc",
          $filter: `receivedDateTime lt ${new Date(state.before).toISOString()}`,
        });
        const url = state.cursor ?? `/me/messages?${params.toString()}`;
        if (state.cursor)
          yield* nextPage(
            state.cursor,
            "/me/messages",
            undefined,
            () => new ProviderError({ message: "Invalid Graph backfill continuation" }),
          );
        const page = yield* get(account.id, pageSchema, url);
        const listed = page.value.map((m) => m.id);
        const ids = select ? yield* select(listed) : listed;
        const messages = yield* Effect.forEach(
          ids,
          (id) =>
            fetchMessage(account, id).pipe(
              Effect.catchTag("PermanentError", () => Effect.succeed(null)),
            ),
          {
            concurrency: 2,
          },
        );
        return {
          messages: messages.filter((m) => m !== null),
          cursor: page["@odata.nextLink"]
            ? yield* nextPage(
                page["@odata.nextLink"],
                "/me/messages",
                { previous: url },
                () =>
                  new ProviderError({ message: "Invalid or repeated Graph backfill continuation" }),
              )
            : null,
          scanned: page.value.length,
        };
      }).pipe(Effect.mapError(readFailure(account.id)));

    const fetchMessage: ProviderAdapter["fetchMessage"] = (account, id) =>
      Effect.gen(function* () {
        const raw = yield* get(
          account.id,
          GraphMessage,
          `/me/messages/${encodeURIComponent(id)}?$select=${MESSAGE_SELECT},parentFolderId&${EXPAND_ATTACHMENTS}`,
        );
        const label = yield* messageLabel(account, raw);
        const attachments =
          expandedAttachments(raw) ??
          (raw.hasAttachments ? yield* fetchAttachments(account.id, id) : []);
        return yield* incomingGraph(account, raw, label, attachments);
      }).pipe(Effect.mapError(writeFailure(account.id)));

    const verifyResetCandidates: NonNullable<ProviderAdapter["verifyResetCandidates"]> = (
      account,
      candidates,
    ) =>
      Effect.gen(function* () {
        const system = yield* Effect.forEach(WELL_KNOWN, (folder) =>
          get(account.id, WithId, `/me/mailFolders/${folder.name}?$select=id`).pipe(
            Effect.map((raw) => ({ id: raw.id, label: folder.label })),
            Effect.catchIf(is404, () => Effect.succeed({ id: folder.name, label: folder.label })),
          ),
        );
        return yield* verifyInChunks(candidates, (chunk) => {
          return retryProvider(
            Effect.gen(function* () {
              const batch = yield* write(account.id, "POST", "/$batch", {
                requests: chunk.map((candidate, index) => ({
                  id: String(index),
                  method: "GET",
                  headers: PREFER,
                  url: `/me/messages/${encodeURIComponent(candidate.providerId)}?$select=id,parentFolderId`,
                })),
              }).pipe(Effect.flatMap(decode(BatchResponse)));
              const now = yield* Clock.currentTimeMillis;
              const delay = batchThrottleDelay(batch.responses, now);
              if (delay !== undefined) {
                readRetryAt.set(
                  account.id,
                  Math.max(readRetryAt.get(account.id) ?? 0, now + delay),
                );
                return yield* new ApiError({
                  status: 429,
                  body: "Reset verification deferred",
                  retryAfter: String(delay / 1000),
                });
              }
              const out: ResetVerification[] = [];
              for (const response of batch.responses) {
                const candidate = chunk.find((_item, index) => String(index) === response.id);
                if (!candidate) continue;
                if (response.status === 404) out.push({ kind: "gone", id: candidate.providerId });
                else if (response.status === 200) {
                  const raw = yield* decode(
                    Schema.Struct({ id: Schema.String, parentFolderId: Schema.String }),
                  )(response.body);
                  if (raw.id !== candidate.providerId) continue;
                  const label =
                    system.find((folder) => folder.id === raw.parentFolderId)?.label ??
                    raw.parentFolderId;
                  out.push({
                    kind: "present",
                    id: candidate.providerId,
                    providerId: raw.id,
                    labels: [
                      label,
                      ...candidate.labels.filter(
                        (value) =>
                          ["UNREAD", "STARRED", "IMPORTANT"].includes(value) ||
                          value.startsWith("category:"),
                      ),
                    ],
                  });
                }
              }
              return out;
            }),
            (error) => error._tag === "ApiError" && isTransient(error),
          );
        });
      }).pipe(Effect.mapError(readFailure(account.id)));

    const fetchCachedHeaders: NonNullable<ProviderAdapter["fetchCachedHeaders"]> = (account, ids) =>
      retryProvider(
        Effect.gen(function* () {
          const batch = yield* write(account.id, "POST", "/$batch", {
            requests: ids.map((id, index) => ({
              id: String(index),
              method: "GET",
              headers: PREFER,
              url: `/me/messages/${encodeURIComponent(id)}?$select=internetMessageId,internetMessageHeaders`,
            })),
          }).pipe(Effect.flatMap(decode(BatchResponse)));
          const now = yield* Clock.currentTimeMillis;
          const delay = batchThrottleDelay(batch.responses, now);
          if (delay !== undefined) {
            readRetryAt.set(account.id, Math.max(readRetryAt.get(account.id) ?? 0, now + delay));
            return yield* new ApiError({
              status: 429,
              body: "Header backfill deferred",
              retryAfter: String(delay / 1000),
            });
          }
          const out: CachedHeaders[] = [];
          const MetadataHeaders = Schema.Struct({
            internetMessageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
            internetMessageHeaders: Schema.optionalKey(
              Schema.NullOr(
                Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
              ),
            ),
          });
          for (const response of batch.responses) {
            const id = ids.find((_id, index) => String(index) === response.id);
            if (id === undefined) continue;
            if (response.status === 404 || response.status === 410)
              out.push({ kind: "unavailable", id });
            else if (response.status === 200) {
              const raw = yield* decode(MetadataHeaders)(response.body);
              const headers = (raw.internetMessageHeaders ?? []).map((h) => ({
                name: h.name.toLowerCase(),
                value: h.value,
              }));
              out.push({
                kind: "headers",
                id,
                headers,
                rfcMessageId:
                  raw.internetMessageId ||
                  headers.find((h) => h.name === "message-id")?.value ||
                  null,
              });
            } else
              return yield* new ApiError({
                status: response.status,
                body: "Header backfill failed",
              });
          }
          return out;
        }),
        (error) => error._tag === "ApiError" && isTransient(error),
      ).pipe(Effect.mapError(readFailure(account.id)));

    const folderMessageCount = (accountId: string, id: string, filter: "all" | "unread") =>
      get(
        accountId,
        Schema.Struct({ "@odata.count": Schema.Int }),
        `/me/mailFolders/${encodeURIComponent(id)}/messages?${new URLSearchParams({ $count: "true", $select: "id", $top: "1", ...(filter === "unread" ? { $filter: "isRead eq false" } : {}) }).toString()}`,
      );
    return {
      resetConnectivity: () => connectivity.reset,
      fetchCachedHeaders: (account, ids) =>
        fetchCachedHeaders(account, ids).pipe(Effect.provideService(BackgroundRead, true)),
      backfill: (...args) => backfill(...args).pipe(Effect.provideService(BackgroundRead, true)),
      fetchMessage,
      verifyResetCandidates: (account, candidates) =>
        verifyResetCandidates(account, candidates).pipe(
          Effect.provideService(BackgroundRead, true),
        ),
      ...settings,
      ...makeOutlookFeatures(get, write),
      ...makeProviderCalendar(
        "outlook",
        (id, schema, path) =>
          api(
            id,
            HttpClientRequest.get(`${GRAPH}${path}`).pipe(
              HttpClientRequest.setHeader(
                "prefer",
                `IdType="ImmutableId", outlook.timezone="${Intl.DateTimeFormat().resolvedOptions().timeZone}"`,
              ),
            ),
          ).pipe(Effect.flatMap(decode(schema))),
        (id, path, body) => write(id, "POST", path, body),
      ),
      search,
      changeLabel,
      connect,
      pull: (...args) => pull(...args).pipe(Stream.provideService(BackgroundRead, true)),
      folderStatus: (account, scope, recheck) => {
        const id = WELL_KNOWN.find((folder) => folder.label === scope)?.name ?? scope;
        const summary = recheck
          ? Effect.succeed(recheck.summary)
          : get(
              account.id,
              Schema.Struct({ totalItemCount: Schema.Int, unreadItemCount: Schema.Int }),
              `/me/mailFolders/${encodeURIComponent(id)}?$select=totalItemCount,unreadItemCount`,
            ).pipe(
              Effect.map((row): FolderStatus => ({
                total: row.totalItemCount,
                unread: row.unreadItemCount,
                threads: null,
                uidNext: null,
                uidValidity: null,
              })),
            );
        return summary.pipe(
          Effect.flatMap((status) => {
            if (!recheck || scope !== "DRAFT" || status.total >= recheck.localTotal)
              return Effect.succeed(status);
            return Effect.gen(function* () {
              const total = (yield* folderMessageCount(account.id, id, "all"))["@odata.count"];
              const unread = (yield* folderMessageCount(account.id, id, "unread"))["@odata.count"];
              return { ...status, total, unread };
            }).pipe(Effect.catch(() => Effect.succeed(status)));
          }),
          Effect.mapError(readFailure(account.id)),
          Effect.provideService(BackgroundRead, true),
        );
      },
      listFolderMessages: (account, folder, cursor, options) =>
        Effect.gen(function* () {
          if (
            options?.includeChildren &&
            cursor === null &&
            !folder.label &&
            (folder.mailbox === "trash" || folder.mailbox === "spam")
          ) {
            const pending = [folder.mailbox === "trash" ? "deleteditems" : "junkemail"];
            const visited = new Set<string>();
            const Page = Schema.Struct({
              value: Schema.Array(WithId),
              "@odata.nextLink": Schema.optionalKey(Schema.String),
            });
            while (pending.length) {
              const id = pending.shift();
              if (id === undefined) break;
              if (visited.has(id) || visited.size >= 1000)
                return yield* new PermanentError({
                  message: "Deleted folder hierarchy repeated or exceeds 1,000 folders.",
                });
              visited.add(id);
              const base = `/me/mailFolders/${encodeURIComponent(id)}`;
              const messages = yield* get(
                account.id,
                Page,
                `${base}/messages?$select=id&$top=${FOLDER_BATCH_LIMIT}`,
              );
              if (messages.value.length)
                return { ids: messages.value.map((m) => m.id), next: null };
              let path: string | null =
                `${base}/childFolders?includeHiddenFolders=true&$select=id&$top=100`;
              const seen = new Set<string>();
              for (const loadPage of graphPages(
                path,
                (pagePath) =>
                  Effect.gen(function* () {
                    if (seen.has(pagePath))
                      return yield* new PermanentError({
                        message: "Deleted folder pagination repeated a page.",
                      });
                    seen.add(pagePath);

                    return yield* get(account.id, Page, pagePath);
                  }),
                () => path,
              )) {
                const children: typeof Page.Type = yield* loadPage;

                pending.push(...children.value.map((child) => child.id));
                const next = children["@odata.nextLink"];
                path = next
                  ? yield* nextPage(
                      next,
                      `${base}/childFolders`,
                      undefined,
                      () =>
                        new PermanentError({ message: "Invalid deleted folder pagination link." }),
                    )
                  : null;
              }
            }
            return { ids: [], next: null };
          }
          const labels: Record<string, string> = {
            inbox: "INBOX",
            sent: "SENT",
            drafts: "DRAFT",
            spam: "SPAM",
            trash: "TRASH",
          };
          const known = WELL_KNOWN.find((f) => f.label === labels[folder.mailbox]);
          const target = folder.label ?? known?.name;
          const base = target
            ? `/me/mailFolders/${encodeURIComponent(target)}/messages`
            : "/me/messages";
          const params = new URLSearchParams({
            $select: "id",
            $top: String(FOLDER_BATCH_LIMIT),
            ...(options?.newestFirst ? { $orderby: "receivedDateTime desc" } : {}),
          });
          const filters: string[] = options?.newestFirst
            ? ["receivedDateTime ge 1900-01-01T00:00:00Z"]
            : [];
          if (options?.unreadOnly) filters.push("isRead eq false");
          if (!target) {
            for (const name of ["junkemail", "deleteditems"]) {
              const ref = yield* get(
                account.id,
                WithId,
                `/me/mailFolders/${encodeURIComponent(name)}?$select=id`,
              );
              filters.push(`parentFolderId ne '${ref.id.replaceAll("'", "''")}'`);
            }
            if (folder.mailbox === "starred") filters.push("flag/flagStatus eq 'flagged'");
            if (folder.mailbox === "important") filters.push("importance eq 'high'");
          }
          if (filters.length) params.set("$filter", filters.join(" and "));
          let path = `${base}?${params.toString()}`;
          if (cursor !== null) {
            path = yield* nextPage(
              cursor,
              base,
              undefined,
              () => new PermanentError({ message: "Invalid folder pagination link." }),
            );
          }
          const page = yield* get(
            account.id,
            Schema.Struct({
              value: Schema.Array(WithId),
              "@odata.nextLink": Schema.optionalKey(Schema.String),
            }),
            path,
          );
          return {
            ids: page.value.map((m) => m.id),
            next: page["@odata.nextLink"]
              ? yield* nextPage(
                  page["@odata.nextLink"],
                  base,
                  { previous: path },
                  () =>
                    new PermanentError({ message: "Invalid or repeated folder pagination link." }),
                )
              : null,
          };
        }).pipe(Effect.mapError(writeFailure(account.id))),
      checkPermanentDelete: (account, folder) =>
        deleteFolderIds(account, folder).pipe(
          Effect.map((ids) => [folder === "trash" ? "TRASH" : "SPAM", ...ids]),
          Effect.mapError(writeFailure(account.id)),
        ),
      permanentlyDelete: (account, ids, folder) =>
        Effect.gen(function* () {
          if (ids.length > FOLDER_BATCH_LIMIT)
            return yield* new PermanentError({
              message: "Permanent delete batch exceeds 100 messages.",
            });
          const subtree = yield* deleteFolderIds(account, folder).pipe(
            Effect.mapError(writeFailure(account.id)),
          );
          const deleted: string[] = [];
          const Metadata = Schema.Struct({ parentFolderId: Schema.String });
          for (const id of ids) {
            const result = yield* Effect.gen(function* () {
              const metadata = yield* get(
                account.id,
                Metadata,
                `/me/messages/${encodeURIComponent(id)}?$select=parentFolderId`,
              ).pipe(
                Effect.map(Option.some),
                Effect.catchIf(is404, () => Effect.succeed(Option.none())),
              );
              if (Option.isNone(metadata) || !subtree.has(metadata.value.parentFolderId))
                return false;
              return yield* write(
                account.id,
                "POST",
                `/me/messages/${encodeURIComponent(id)}/permanentDelete`,
              ).pipe(
                Effect.as(true),
                Effect.catchIf(is404, () => Effect.succeed(false)),
              );
            }).pipe(Effect.mapError(writeFailure(account.id)), Effect.result);
            if (result._tag === "Failure")
              return {
                kind: "partial",
                ids: deleted,
                error: result.failure,
              } satisfies PermanentDeleteBatch;
            if (result.success) deleted.push(id);
          }
          return { kind: "complete", ids: deleted } satisfies PermanentDeleteBatch;
        }),
      push,
      markReadBatch: (account, ids) =>
        Effect.forEach(
          ids,
          (id) =>
            write(account.id, "PATCH", `/me/messages/${encodeURIComponent(id)}`, {
              isRead: true,
            }).pipe(
              Effect.catchIf(is404, () => Effect.void),
              Effect.asVoid,
              Effect.mapError(writeFailure(account.id)),
            ),
          { discard: true, concurrency: 5 },
        ),
    } satisfies Pick<
      ProviderAdapter,
      | "resetConnectivity"
      | "fetchCachedHeaders"
      | "backfill"
      | "fetchMessage"
      | "verifyResetCandidates"
      | "search"
      | "changeLabel"
      | "connect"
      | "pull"
      | "folderStatus"
      | "listFolderMessages"
      | "checkPermanentDelete"
      | "permanentlyDelete"
      | "push"
      | "markReadBatch"
    >;
  });
