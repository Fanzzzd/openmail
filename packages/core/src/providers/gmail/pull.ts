import { Effect, Option, Schema, Stream } from "effect";
import { HttpClientRequest } from "effect/http";
import { CACHED_HEADER_NAMES } from "../../sync/header-backfill.js";
import type { CachedHeaders, FolderStatus, ResetVerification } from "../../sync/sync-records.js";
import { Buffer } from "../../platform/bytes.js";
import { BatchResponse, deferIfThrottled, verifyInChunks } from "../provider-batch.js";
import { BackgroundRead } from "../provider-connectivity.js";
import { gmailPages } from "../provider-pages.js";
import { retryProvider } from "../provider-retry.js";

import { type AttachmentRef, MEDIA_RAW_TOO_LARGE, pickAttachment } from "../../mime/attachments.js";
import type { Account } from "../../domain/account.js";
import type { IncomingMessage } from "../../domain/message.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../../domain/errors.js";
import type { Change, ProviderAdapter } from "../adapter.js";

import { gmailSearch, searchIncludesSpecialFolders } from "../../search/search.js";
import {
  INITIAL_CURSOR,
  is404,
  CONCURRENCY,
  readFailure,
  RawMessage,
  writeFailure,
  GmailMessage,
  AttachmentBody,
  MessageList,
  isTransient,
  Metadata,
  COUNT_RECHECK_PAGE_SIZE,
  COUNT_RECHECK_PAGES,
  COUNT_RECHECK_CAPACITY,
  decode,
} from "./api.js";
import type { GmailClient } from "./client.js";
import { makeGmailHistory } from "./history.js";
import { attachmentParts } from "./parse.js";

/** The read side of the Gmail adapter: pull, search, backfill, raw messages, attachments, reset checks and folder counts. */
export const makeGmailPull = (client: GmailClient) => {
  const { codec, api, get, fetchUserLabels, fetchMessage } = client;
  const { readHistory, fullSyncPlan } = makeGmailHistory(client);

  const pull = (
    account: Account,
    cursor: Option.Option<string>,
    scope?: "inbox",
    incrementalOnly = false,
    stored?: (providerIds: readonly string[]) => Effect.Effect<ReadonlySet<string>>,
  ): Stream.Stream<Change, ProviderFailure> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const labels = scope ? [] : yield* fetchUserLabels(account.id);
        const saved = Option.getOrUndefined(cursor);
        const resumeFrom = saved?.startsWith(INITIAL_CURSOR)
          ? saved.slice(INITIAL_CURSOR.length)
          : undefined;
        const history = resumeFrom === undefined ? cursor : Option.none<string>();
        const incremental = Option.isSome(history)
          ? yield* readHistory(account.id, history.value, scope)
          : Option.none();
        if (incrementalOnly && Option.isNone(incremental))
          return yield* new ProviderError({
            message: "Foreground sync required to renew the cursor",
          });
        const full = Option.isNone(incremental)
          ? yield* fullSyncPlan(account.id, scope, Option.isSome(history), resumeFrom)
          : undefined;
        const plan = Option.isSome(incremental) ? incremental.value : full!;
        const total = plan.changedIds.length;
        // A first sync fetches only what an earlier attempt did not store. The listing
        // still covers every message, so a stored one is not refetched in full.
        // An inbox poll that starts from a first sync's checkpoint skips stored mail the same way.
        const initial = !scope && full !== undefined && Option.isNone(history);
        const resuming = full !== undefined && resumeFrom !== undefined;
        const skip =
          (initial || resuming) && stored ? yield* stored(plan.changedIds) : new Set<string>();
        const pending = skip.size ? plan.changedIds.filter((id) => !skip.has(id)) : plan.changedIds;
        const done = total - pending.length;
        const checkpoint: Change[] =
          initial && resumeFrom === undefined
            ? [{ _tag: "Cursor", cursor: `${INITIAL_CURSOR}${plan.cursor}`, checkpoint: true }]
            : [];

        const fetched = Stream.fromIterable(pending).pipe(
          Stream.mapEffect(
            (id, i) =>
              (plan.addedIds.has(id)
                ? fetchMessage(account.id, id).pipe(
                    Effect.map((m): Change =>
                      Option.isSome(m)
                        ? { _tag: "Upsert", message: m.value }
                        : { _tag: "Delete", providerId: id },
                    ),
                  )
                : get(
                    account.id,
                    Schema.Struct({
                      id: Schema.String,
                      labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
                    }),
                    `/messages/${encodeURIComponent(id)}`,
                    { format: "minimal", fields: "id,labelIds" },
                  ).pipe(
                    Effect.map((m): Change => ({
                      _tag: "MessageLabels",
                      providerId: m.id,
                      labels: m.labelIds ?? [],
                    })),
                    Effect.catchIf(is404, () =>
                      Effect.succeed<Change>({ _tag: "Delete", providerId: id }),
                    ),
                  )
              ).pipe(
                Effect.map((change): Change[] => [
                  change,
                  { _tag: "Progress", fetched: done + i + 1, total },
                ]),
              ),
            { concurrency: CONCURRENCY },
          ),
          Stream.flattenIterable,
        );
        const deletes = plan.deletedIds.map((providerId): Change => ({
          _tag: "Delete",
          providerId,
        }));
        // The history cursor only covers the whole batch, so it goes last.
        const head: Change = { _tag: "Labels", labels };
        const tail: Change = { _tag: "Cursor", cursor: plan.cursor };
        return Stream.fromIterable(scope ? [] : [head, ...checkpoint]).pipe(
          Stream.concat(fetched),
          Stream.concat(Stream.fromIterable(deletes)),
          Stream.concat(
            Stream.fromIterable(
              !scope && Option.isSome(history) && Option.isNone(incremental) && full
                ? [{ _tag: "Reset" as const, keep: plan.changedIds, since: full.since }]
                : [],
            ),
          ),
          Stream.concat(Stream.succeed(tail)),
        );
      }).pipe(Effect.withSpan("Gmail.pull")),
    ).pipe(Stream.mapError(readFailure(account.id)));

  const fetchRaw = Effect.fn("Gmail.fetchRaw")(
    function* (account: Account, providerId: string, maxBytes?: number) {
      if (maxBytes !== undefined) {
        const metadata = yield* get(
          account.id,
          Schema.Struct({ sizeEstimate: Schema.Number }),
          `/messages/${encodeURIComponent(providerId)}`,
          { format: "minimal", fields: "sizeEstimate" },
        );
        if (metadata.sizeEstimate > maxBytes || metadata.sizeEstimate <= 0)
          return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
      }
      const { raw } = yield* get(
        account.id,
        RawMessage,
        `/messages/${encodeURIComponent(providerId)}`,
        {
          format: "raw",
        },
      );
      if (maxBytes !== undefined && (raw.length * 3) / 4 > maxBytes + 3)
        return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
      return new Uint8Array(Buffer.from(raw, "base64"));
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const fetchAttachment = Effect.fn("Gmail.fetchAttachment")(
    function* (account: Account, providerId: string, ref: AttachmentRef) {
      const message = yield* get(
        account.id,
        GmailMessage,
        `/messages/${encodeURIComponent(providerId)}`,
        {
          format: "full",
        },
      );
      const part = pickAttachment(attachmentParts(message.payload), (p) => p.filename ?? "", ref);
      if (!part) {
        const bytes = yield* fetchRaw(account, providerId);
        const parsed = yield* Effect.tryPromise({
          try: () => codec.parse(bytes),
          catch: () => new ProviderError({ message: "Cannot parse attachment MIME" }),
        });
        const rawAttachment = pickAttachment(
          parsed.attachments.filter((candidate) => !candidate.related),
          (candidate) => candidate.filename ?? "attachment",
          ref,
        );
        if (rawAttachment) return new Uint8Array(rawAttachment.content);
        return yield* new PermanentError({ message: `No attachment ${ref.filename}` });
      }
      // Small parts come inline; bigger ones through the attachments endpoint.
      const data = part.body.data
        ? part.body.data
        : part.body.attachmentId
          ? (yield* get(
              account.id,
              AttachmentBody,
              `/messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
            )).data
          : "";
      return new Uint8Array(Buffer.from(data, "base64"));
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const search: ProviderAdapter["search"] = (account, query) =>
    Effect.gen(function* () {
      const labels = yield* fetchUserLabels(account.id);
      const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
      const messages: IncomingMessage[] = [];
      let lastPageToken: string | undefined;
      for (const loadPage of gmailPages((pageToken) =>
        get(account.id, MessageList, "/messages", {
          q: gmailSearch(query, labels),
          ...(searchIncludesSpecialFolders(query) ? { includeSpamTrash: "true" } : {}),
          maxResults: String(Math.min(500, limit - messages.length)),
          ...(pageToken ? { pageToken } : {}),
        }),
      )) {
        const page = yield* loadPage;
        const fetched = yield* Effect.forEach(
          page.messages ?? [],
          (m) => fetchMessage(account.id, m.id),
          { concurrency: CONCURRENCY },
        );
        for (const message of fetched) if (Option.isSome(message)) messages.push(message.value);
        lastPageToken = page.nextPageToken;
        if (messages.length >= limit) break;
      }
      return { messages, truncated: lastPageToken !== undefined };
    }).pipe(Effect.mapError(writeFailure(account.id)));

  const backfill: ProviderAdapter["backfill"] = (account, state, select) =>
    Effect.gen(function* () {
      const page = yield* get(account.id, MessageList, "/messages", {
        q: `before:${Math.ceil(state.before / 1000)}`,
        includeSpamTrash: "true",
        maxResults: "50",
        ...(state.cursor ? { pageToken: state.cursor } : {}),
      });
      const listed = (page.messages ?? []).map((m) => m.id);
      const ids = select ? yield* select(listed) : listed;
      const messages = yield* Effect.forEach(ids, (id) => fetchMessage(account.id, id), {
        concurrency: 2,
      });
      return {
        messages: messages.flatMap((m) => (Option.isSome(m) ? [m.value] : [])),
        cursor: page.nextPageToken ?? null,
        scanned: (page.messages ?? []).length,
      };
    }).pipe(Effect.mapError(readFailure(account.id)));

  const verifyResetCandidates: NonNullable<ProviderAdapter["verifyResetCandidates"]> = (
    account,
    candidates,
  ) =>
    Effect.gen(function* () {
      return yield* verifyInChunks(candidates, (chunk) => {
        const boundary = "openmail_reset_batch";
        const parts = chunk
          .map(
            (candidate, index) =>
              `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${index}>\r\n\r\nGET /gmail/v1/users/me/messages/${encodeURIComponent(candidate.providerId)}?format=minimal&fields=id,labelIds HTTP/1.1\r\n\r\n`,
          )
          .join("");
        const body = `${parts}--${boundary}--\r\n`;
        return retryProvider(
          Effect.gen(function* () {
            const batch = yield* api(
              account.id,
              HttpClientRequest.post("https://gmail.googleapis.com/batch/gmail/v1").pipe(
                HttpClientRequest.bodyText(body, `multipart/mixed; boundary=${boundary}`),
              ),
            ).pipe(Effect.flatMap(decode(BatchResponse)));
            yield* deferIfThrottled(batch.responses, "Reset verification deferred");
            const out: ResetVerification[] = [];
            for (const response of batch.responses) {
              const candidate = chunk.find((_item, index) => String(index) === response.id);
              if (!candidate) continue;
              if (response.status === 404) out.push({ kind: "gone", id: candidate.providerId });
              else if (response.status === 200) {
                const raw = yield* decode(
                  Schema.Struct({
                    id: Schema.String,
                    labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
                  }),
                )(response.body);
                if (raw.id === candidate.providerId)
                  out.push({
                    kind: "present",
                    id: candidate.providerId,
                    providerId: raw.id,
                    labels: raw.labelIds ?? [],
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
    Effect.gen(function* () {
      const out: CachedHeaders[] = [];
      for (const id of ids) {
        const metadata = yield* get(account.id, Metadata, `/messages/${encodeURIComponent(id)}`, {
          format: "metadata",
          metadataHeaders: CACHED_HEADER_NAMES,
          fields: "payload/headers",
        }).pipe(
          Effect.map(Option.some),
          Effect.catchIf(is404, () => Effect.succeed(Option.none())),
        );
        if (Option.isNone(metadata)) out.push({ kind: "unavailable", id });
        else {
          const headers = (metadata.value.payload.headers ?? []).map((h) => ({
            name: h.name.toLowerCase(),
            value: h.value,
          }));
          out.push({
            kind: "headers",
            id,
            headers,
            rfcMessageId: headers.find((h) => h.name === "message-id")?.value || null,
          });
        }
      }
      return out;
    }).pipe(Effect.mapError(readFailure(account.id)));

  const labelMessageCount = (accountId: string, scope: string, filter: "all" | "unread") =>
    Effect.gen(function* () {
      const ids = new Set<string>();
      const pages = new Set<string>();
      let pageNumber = 0;
      for (const loadPage of gmailPages((pageToken) =>
        get(accountId, MessageList, "/messages", {
          labelIds: filter === "unread" && scope !== "UNREAD" ? [scope, "UNREAD"] : [scope],
          includeSpamTrash: "true",
          maxResults: String(COUNT_RECHECK_PAGE_SIZE),
          ...(pageToken ? { pageToken } : {}),
        }),
      )) {
        const page = yield* loadPage;
        for (const message of page.messages ?? []) ids.add(message.id);
        const pageToken = page.nextPageToken;
        if (!pageToken) return Option.some(ids.size);
        if (pages.has(pageToken))
          return yield* new ProviderError({ message: "Label count pagination repeated" });
        pages.add(pageToken);
        if (++pageNumber >= COUNT_RECHECK_PAGES) break;
      }
      return Option.none<number>();
    });
  const folderStatus: ProviderAdapter["folderStatus"] = (account, scope, recheck) => {
    const summary = recheck
      ? Effect.succeed(recheck.summary)
      : get(
          account.id,
          Schema.Struct({
            messagesTotal: Schema.Int,
            messagesUnread: Schema.Int,
            threadsTotal: Schema.Int,
          }),
          `/labels/${encodeURIComponent(scope)}`,
        ).pipe(
          Effect.map((row): FolderStatus => ({
            total: row.messagesTotal,
            unread: row.messagesUnread,
            threads: row.threadsTotal,
            uidNext: null,
            uidValidity: null,
          })),
        );
    return summary.pipe(
      Effect.flatMap((status) => {
        if (
          !recheck ||
          status.total >= recheck.localTotal ||
          status.total > COUNT_RECHECK_CAPACITY ||
          (scope !== "DRAFT" && !scope.startsWith("CATEGORY_"))
        )
          return Effect.succeed(status);
        return Effect.gen(function* () {
          const total = yield* labelMessageCount(account.id, scope, "all");
          if (Option.isNone(total)) return status;
          const unread = yield* labelMessageCount(account.id, scope, "unread");
          if (Option.isNone(unread)) return status;
          return { ...status, total: total.value, unread: unread.value, threads: null };
        }).pipe(Effect.catch(() => Effect.succeed(status)));
      }),
      Effect.mapError(readFailure(account.id)),
      Effect.provideService(BackgroundRead, true),
    );
  };

  return {
    pull,
    fetchRaw,
    fetchAttachment,
    search,
    backfill,
    verifyResetCandidates,
    fetchCachedHeaders,
    folderStatus,
  };
};
