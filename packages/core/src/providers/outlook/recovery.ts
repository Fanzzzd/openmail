import { Effect, Schema } from "effect";
import type { Account } from "../../domain/domain.js";
import { ProviderError } from "../../domain/errors.js";
import type { CachedHeaders, ResetVerification } from "../../sync/sync-records.js";
import { BatchResponse, deferIfThrottled, verifyInChunks } from "../provider-batch.js";
import { BackgroundRead } from "../provider-connectivity.js";
import { ApiError } from "../provider-http.js";
import { retryProvider } from "../provider-retry.js";
import type { ProviderAdapter } from "../adapter.js";
import { outlookStateLabel } from "../../sync/sync-reset.js";
import type { OutlookClient, OutlookSyncSources } from "./client.js";
import {
  decode,
  EXPAND_ATTACHMENTS,
  GraphMessage,
  is404,
  isTransient,
  MESSAGE_SELECT,
  nextPage,
  PREFER,
  readFailure,
  WELL_KNOWN,
  WithId,
  writeFailure,
} from "./graph.js";
import type { OutlookRead } from "./parse.js";
import { expandedAttachments } from "./parse.js";
export const makeOutlookRecovery = (
  client: OutlookClient,
  reader: OutlookRead,
  sources: OutlookSyncSources,
) => {
  const { deferReads, get, write } = client;
  const { incomingGraph } = reader;
  const { fetchAttachments } = sources;
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
            yield* deferIfThrottled(batch.responses, "Reset verification deferred", (delay) =>
              deferReads(account.id, delay),
            );
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
                  labels: [label, ...candidate.labels.filter(outlookStateLabel)],
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
        yield* deferIfThrottled(batch.responses, "Header backfill deferred", (delay) =>
          deferReads(account.id, delay),
        );
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
  return {
    fetchCachedHeaders: (account, ids) =>
      fetchCachedHeaders(account, ids).pipe(Effect.provideService(BackgroundRead, true)),
    backfill: (...args) => backfill(...args).pipe(Effect.provideService(BackgroundRead, true)),
    fetchMessage,
    verifyResetCandidates: (account, candidates) =>
      verifyResetCandidates(account, candidates).pipe(Effect.provideService(BackgroundRead, true)),
  } satisfies Pick<
    ProviderAdapter,
    "fetchCachedHeaders" | "backfill" | "fetchMessage" | "verifyResetCandidates"
  >;
};
