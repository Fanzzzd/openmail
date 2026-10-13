import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { categoryKey, mergeCategoryNames } from "../domain/categories.js";
import type { Account, Attachment, IncomingMessage, MailOp } from "../domain/domain.js";
import { AuthError, PermanentError, ProviderError } from "../domain/errors.js";
import { stripMessageIdBrackets } from "../message-id.js";
import { makeOutlookFeatures } from "../outlook-features.js";
import { makeOutlookSettings } from "../outlook-settings.js";
import { hasSignedContainer } from "../platform/mime-compat.js";
import { makeProviderCalendar } from "../provider-calendar.js";
import { BackgroundRead } from "../provider-connectivity.js";
import { ApiError } from "../provider-http.js";
import { graphPages } from "../provider-pages.js";
import { uncertainWrite } from "../provider-retry.js";
import { graphSearch, matchesSearch, parseSearchQuery, searchMailboxLabel } from "../search.js";
import { type ProviderAdapter } from "../services.js";
import type { FolderStatus } from "../sync-health.js";
import type { OutlookClient } from "./client.js";
import { makeOutlookFolders } from "./folders.js";
import {
  AttachmentList,
  decode,
  destination,
  FolderPage,
  GRAPH,
  GraphMessage,
  is404,
  nextPage,
  readFailure,
  SearchRequest,
  SELECT,
  SKIPPED,
  WELL_KNOWN,
  WithId,
  writeFailure,
} from "./graph.js";
import type { OutlookRead } from "./parse.js";
import { expandedAttachments } from "./parse.js";
import { makeOutlookPull } from "./pull.js";
import { makeOutlookRecovery } from "./recovery.js";
export const makeOutlookSync = (client: OutlookClient, reader: OutlookRead) =>
  Effect.sync(() => {
    const { connectivity, api, get, write, connect, keepAlive } = client;

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
            (pagePath) => get(accountId, FolderPage, pagePath),
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

    const push = Effect.fn("Outlook.push")(
      function* (account: Account, providerId: string, op: MailOp) {
        if (op.kind === "copy")
          yield* new PermanentError({
            message: "Folder copies are available for IMAP accounts.",
          });
        const path = `/me/messages/${encodeURIComponent(providerId)}`;
        if (op.kind === "classification") {
          yield* write(account.id, "PATCH", path, { inferenceClassification: op.value });
          return;
        }
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

    const setClassificationOverride: NonNullable<ProviderAdapter["setClassificationOverride"]> = (
      account,
      sender,
      classifyAs,
    ) =>
      write(account.id, "POST", "/me/inferenceClassification/overrides", {
        classifyAs,
        senderEmailAddress: { name: sender.name, address: sender.address },
      }).pipe(Effect.asVoid, Effect.mapError(writeFailure(account.id)));
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
            get(
              account.id,
              Schema.Struct({
                value: Schema.Array(GraphMessage),
                "@odata.nextLink": Schema.optionalKey(Schema.String),
              }),
              pagePath,
            ),
          () => url,
        )) {
          const page: {
            readonly value: readonly GraphMessage[];
            readonly "@odata.nextLink"?: string;
          } = yield* loadPage;

          let consumed = 0;
          // Parse in order only as many as the limit still needs, so messages past the
          // last result skip HTML extraction. A chunk can only fill the limit at its end.
          while (consumed < page.value.length && messages.length < limit) {
            const chunk = page.value.slice(consumed, consumed + limit - messages.length);
            const parsedChunk = yield* Effect.forEach(
              chunk,
              (raw) => {
                const label =
                  system.find((f) => f.id === raw.parentFolderId)?.label ??
                  folders.find((f) => f.id === raw.parentFolderId)?.id;
                return label
                  ? reader.parseGraph(raw, label, expandedAttachments(raw) ?? [])
                  : Effect.succeed(undefined);
              },
              { concurrency: reader.parseConcurrency },
            );
            for (const [index, raw] of chunk.entries()) {
              scanned++;
              consumed++;
              const parsed = parsedChunk[index];
              if (!parsed) continue;
              const message: IncomingMessage = {
                ...parsed,
                bodyCached:
                  !(raw.hasAttachments && raw.attachments === undefined) &&
                  !hasSignedContainer(parsed),
              };
              if (matchesSearch(message, query, folderNames, "outlook")) messages.push(message);
            }
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

    const folderMessageCount = (accountId: string, id: string, filter: "all" | "unread") =>
      get(
        accountId,
        Schema.Struct({ "@odata.count": Schema.Int }),
        `/me/mailFolders/${encodeURIComponent(id)}/messages?${new URLSearchParams({ $count: "true", $select: "id", $top: "1", ...(filter === "unread" ? { $filter: "isRead eq false" } : {}) }).toString()}`,
      );
    return {
      ...makeOutlookPull(client, reader, { listCustomFolders, fetchAttachments }),
      ...makeOutlookRecovery(client, reader, { listCustomFolders, fetchAttachments }),
      ...makeOutlookFolders(client),
      resetConnectivity: () => connectivity.reset,
      keepAlive,
      ...settings,
      setClassificationOverride,
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
      push,
    } satisfies Pick<
      ProviderAdapter,
      | "resetConnectivity"
      | "keepAlive"
      | "search"
      | "changeLabel"
      | "connect"
      | "folderStatus"
      | "push"
      | "setClassificationOverride"
    >;
  });
export interface OutlookSyncSources {
  listCustomFolders: (
    accountId: string,
  ) => Effect.Effect<
    readonly { id: string; name: string }[],
    Effect.Error<ReturnType<OutlookClient["get"]>>
  >;
  fetchAttachments: (
    accountId: string,
    id: string,
  ) => Effect.Effect<Attachment[], Effect.Error<ReturnType<OutlookClient["get"]>>>;
}
