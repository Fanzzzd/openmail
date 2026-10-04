import { Clock, Effect, Option, Queue, Stream } from "effect";
import type { Account } from "../domain.js";
import { ProviderError, type ProviderFailure } from "../errors.js";
import { BackgroundRead } from "../provider-connectivity.js";
import { logInvalidGraphCursor } from "../provider-diagnostics.js";
import { graphPages } from "../provider-pages.js";
import { type Change, type ProviderAdapter } from "../services.js";
import { logSyncReset } from "../sync-reset.js";
import type { GraphClient } from "./client.js";
import {
  CONCURRENCY,
  decodeCursor,
  EXPAND_ATTACHMENTS,
  GRAPH,
  GraphMessage,
  type GraphSyncFolder,
  ID_TYPE_KEY,
  INITIAL_WINDOW_DAYS,
  is404,
  is410,
  MESSAGE_SELECT,
  nextPage,
  readFailure,
  SELECT,
  WELL_KNOWN,
  WINDOW_KEY,
  WithId,
} from "./graph.js";
import type { OutlookRead } from "./parse.js";
import { expandedAttachments } from "./parse.js";
import type { OutlookSyncSources } from "./sync.js";
export const makeOutlookPull = (
  client: GraphClient,
  reader: OutlookRead,
  sources: OutlookSyncSources,
) => {
  const { get, getDelta } = client;
  const { incomingGraph } = reader;
  const { listCustomFolders, fetchAttachments } = sources;
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
          const folders: GraphSyncFolder[] = [
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
              [...(changedFolders.get(providerId) ?? [])].some((label) => removedLabels.has(label))
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
            if (gone) yield* Queue.offer(queue, { _tag: "DeleteLabel", label: key, partial: true });
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
  return {
    pull: (...args) => pull(...args).pipe(Stream.provideService(BackgroundRead, true)),
  } satisfies Pick<ProviderAdapter, "pull">;
};
