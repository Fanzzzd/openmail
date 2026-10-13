import { Effect, Option, Schema } from "effect";
import { PermanentError } from "../../domain/errors.js";
import { FOLDER_BATCH_LIMIT, type PermanentDeleteBatch } from "../../domain/folder-actions.js";
import { graphPages } from "../provider-pages.js";
import { type ProviderAdapter } from "../../services.js";
import type { OutlookClient } from "./client.js";
import { is404, nextPage, WELL_KNOWN, WithId, writeFailure } from "./graph.js";
export const makeOutlookFolders = (client: OutlookClient) => {
  const { get, write, deleteFolderIds } = client;

  return {
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
            if (messages.value.length) return { ids: messages.value.map((m) => m.id), next: null };
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
    "listFolderMessages" | "checkPermanentDelete" | "permanentlyDelete" | "markReadBatch"
  >;
};
