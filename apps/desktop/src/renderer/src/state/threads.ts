/**
 * The thread list, paged. A page is 100 threads older than the oldest one
 * already shown (`before`). Each list query keeps how many pages it wants and
 * what it has loaded; asking for one more page fetches only that page, and a
 * refresh reloads the loaded extent in one query.
 */
import {
  DEFAULT_PREFS,
  inboxCategories,
  liveSearchText,
  searchedFieldText,
  mergeSearchResults,
  parseSearchQuery,
  searchInputError,
  searchInputProblem,
} from "@openmail/core/schema";
import { Effect, Option, Stream, Schedule } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { ThreadQuery, ThreadSummary } from "../../../shared/api";
import type { AppError } from "../lib/errors";
import { supportsInInboxFilter } from "../lib/folder-actions";
import { MailClient } from "./rpc";
import { OVERVIEW, scopeAccountIds, categoryAccounts, type View } from "../lib/view";
import { type Loaded, PAGE, refreshPages, searchExtent } from "./list-pages";
import { Keys } from "./keys";
import { accountsAtom, organizationAtom, prefsAtom } from "./queries";
import { filtersAtom, searchScopeAtom, searchTextAtom, viewAtom } from "./ui";

const searchRefresh = Atom.make(Stream.fromSchedule(Schedule.spaced("10 seconds")));
/** Initial server search stays bounded. Local ranked search grows its candidate window. */
const SEARCH_LIMIT = 200;

/** A thread query without its page cursor and size. */
type ListQuery = Omit<ThreadQuery, "before" | "beforeId" | "limit">;

/** Fetches pages until `wanted` are loaded, continuing from `from` when given. */
const loadPages = (query: ListQuery, wanted: number, from: Loaded | undefined) =>
  Effect.gen(function* () {
    const call = yield* MailClient;
    if (query.search)
      return yield* searchExtent(query, wanted, (q) => call("Threads", { query: q }));
    const limit = PAGE;
    let { threads, pages, done } = from ?? { threads: [], pages: 0, done: false };
    while (pages < wanted && !done) {
      const oldest = threads.at(-1);
      const page = yield* call("Threads", {
        query: { ...query, ...(oldest ? { before: oldest.date, beforeId: oldest.id } : {}), limit },
      });
      threads = [...threads, ...page];
      pages += 1;
      done = page.length < limit;
    }
    return { threads, pages, done, requested: wanted } satisfies Loaded;
  });

/**
 * Counts invalidations of the thread lists. A list reads this rather than registering the key
 * itself. The list on screen then refreshes at once, and a list kept only by its idle TTL goes
 * stale and refreshes, from the rows it had, when it shows again. Atom.withReactivity kept every
 * cached list observed, so each change re-ran every mailbox and search opened in the last five
 * minutes: 3.7 s of main-process time for one cleared search on a 20k-message database.
 */
export const threadsVersionAtom = Atom.make(
  (get): number => Option.getOrElse(get.self<number>(), () => 0) + 1,
).pipe(Atom.withReactivity([Keys.threads]), Atom.keepAlive);

/**
 * How many of a list's rows the person can reach without paging: through the last row its window
 * renders or the last selected row, whichever is further. MessageList writes it; a refresh reads
 * it once, without depending on it, to bound how many rows it reads again (see refreshPages).
 */
export const listReachAtom = Atom.family((_query: ListQuery) =>
  Atom.make<number | undefined>(undefined).pipe(Atom.keepAlive),
);

// Atom.family holds members weakly, so each family returns the atom itself.
// A wrapper object would be collected while its atoms are still mounted, and
// the next lookup would start a second list from page one.
const wantedPages = Atom.family((_query: ListQuery) => Atom.make(1));

const loadedPages = Atom.family((query: ListQuery) => {
  const wanted = wantedPages(query);
  let requested = 0;
  const loaded = MailClient.runtime
    .atom((get) => {
      get(threadsVersionAtom);
      const want = get(wanted);
      const increased = want > requested;
      requested = want;
      const previous = get
        .self<AsyncResult.AsyncResult<Loaded, AppError>>()
        .pipe(Option.flatMap(AsyncResult.value), Option.getOrUndefined);
      // Only an increased request may fetch history; invalidation refreshes cached rows.
      const continuing = increased ? previous : undefined;
      // Refresh the rows within reach so scroll coordinates and selection remain valid.
      const reach = get.once(listReachAtom(query));
      return Effect.gen(function* () {
        if (!continuing && previous) {
          const call = yield* MailClient;
          return yield* refreshPages(
            query,
            previous,
            (q) => call("Threads", { query: q }),
            reach,
          ).pipe(Effect.map((next) => ({ ...next, requested: want })));
        }
        let remoteDone =
          continuing?.remoteDone ??
          previous?.remoteDone ??
          (query.search !== undefined || query.mailbox === "drafts" || query.mailbox === "snoozed");
        if (continuing?.done && !remoteDone) {
          const call = yield* MailClient;
          remoteDone = (yield* call("FetchOlder", { query })).done;
        }
        const next = yield* loadPages(
          query,
          continuing ? continuing.pages + 1 : 1,
          continuing ? { ...continuing, done: false } : undefined,
        );
        return { ...next, remoteDone, requested: want };
      });
    })
    .pipe(Atom.setIdleTTL("5 minutes"));
  return query.search ? loaded.pipe(Atom.makeRefreshOnSignal(searchRefresh)) : loaded;
});

export const pagedList = (query: ListQuery) => ({
  wanted: wantedPages(query),
  loaded: loadedPages(query),
});

type Read = <A>(atom: Atom.Atom<A>) => A;

/** The list query a view opens with and no search; null on the overview, which has no list. */
export function viewListQuery(get: Read, view: View): ListQuery | null {
  if (view.space === OVERVIEW) return null;
  const accounts = AsyncResult.getOrElse(get(accountsAtom), () => []);
  const baseScope = scopeAccountIds(view, accounts);
  const organization = AsyncResult.getOrElse(get(organizationAtom), () => []);
  const scope = view.label?.id.startsWith("CATEGORY_")
    ? categoryAccounts(view, accounts)
        .filter(
          (a) =>
            inboxCategories(a.provider).some((category) => category === view.label?.id) &&
            organization.find((o) => o.accountId === a.id)?.categories !== false,
        )
        .map((a) => a.id)
    : baseScope;
  const common = scope ? { accountIds: scope } : {};
  const filters = filtersAtom.forView(get, view);
  const grouping = AsyncResult.getOrElse(get(prefsAtom), () => DEFAULT_PREFS).threadGrouping;
  // Optional fields are left out rather than set to undefined: the main
  // process decodes the query strictly.
  return {
    ...common,
    ...(grouping ? {} : { flat: true }),
    mailbox: view.mailbox,
    ...(view.label ? { label: view.label.id } : {}),
    ...(filters.enabled
      ? {
          listFilters: {
            ...filters,
            inInbox: supportsInInboxFilter(view, accounts) && filters.inInbox,
          },
        }
      : {}),
  };
}

/**
 * Puts a view's list in the list cache ahead of a switch: its first page when the view has none,
 * a revalidation when its cached rows went stale, and nothing when they are fresh. The switch then
 * shows rows from the cache before any list request (see docs/list-loading.md).
 */
export function prefetchView(
  registry: AtomRegistry.AtomRegistry,
  view: View,
  { missingOnly = false }: { missingOnly?: boolean } = {},
) {
  const query = viewListQuery((atom) => registry.get(atom), view);
  if (!query) return null;
  const { loaded } = pagedList(query);
  // Background warming fills only lists the cache lacks. A cached list, stale or not, refreshes
  // when it shows or when the pointer reaches its row, never because warming ran again.
  if (missingOnly && registry.getNodes().has(loaded)) return null;
  registry.get(loaded);
  return loaded;
}

/** The query behind the list on screen; null on the overview, which has no list. */
export const listQueryAtom = Atom.make((get): ListQuery | null => {
  const view = get(viewAtom);
  const query = viewListQuery(get, view);
  // A last word too short to search yet keeps the list on the search without it.
  const search = searchedFieldText(get(searchTextAtom)).trim();
  if (!query || !search) return query;
  const { listFilters: _filters, flat: _flat, ...common } = query;
  return {
    ...common,
    search,
    searchScope: get(searchScopeAtom),
    flat: !AsyncResult.getOrElse(get(prefsAtom), () => DEFAULT_PREFS).threadGrouping,
  };
});

/**
 * The query the local list runs: the list query, with the search's unfinished last word as a
 * prefix. Server search runs the list query itself.
 */
const localQueryAtom = Atom.make((get): ListQuery | null => {
  const query = get(listQueryAtom);
  if (!query?.search) return query;
  const search = liveSearchText(get(searchTextAtom));
  return search === `${query.search}*` ? { ...query, search } : query;
});

export interface ThreadList {
  threads: readonly ThreadSummary[];
  /** No result for this query yet; `threads` may still be the previous view's. */
  loading: boolean;
  /** A request for this list is in flight: its first page, a refresh or an older page. */
  waiting: boolean;
  /** An older page than the ones shown is being fetched for this query. */
  loadingMore: boolean;
  /** Older threads exist and no page is in flight. */
  canLoadMore: boolean;
  exhausted: boolean;
  loadError: boolean;
  moreNotLoaded: number | null;
  searchingServer: boolean;
  searchTruncated: boolean;
  searchErrorAccounts: readonly string[];
  searchReauthAccounts: readonly string[];
  /** Why the search can't run: too many terms or too deep nesting. */
  searchInputInvalid: false | SearchInputProblem;
  /** Per account, the operators its server search can't use, as the person typed them. */
  searchIgnored: readonly SearchIgnored[];
}

export type SearchInputProblem = "terms" | "depth";
export interface SearchIgnored {
  readonly accountId: string;
  readonly operators: readonly string[];
}

const EMPTY: ThreadList = {
  threads: [],
  loading: false,
  waiting: false,
  loadingMore: false,
  canLoadMore: false,
  exhausted: false,
  loadError: false,
  moreNotLoaded: null,
  searchingServer: false,
  searchTruncated: false,
  searchErrorAccounts: [],
  searchReauthAccounts: [],
  searchInputInvalid: false,
  searchIgnored: [],
};

// Separate request: local hits can render while the network is in flight.
export const serverList = Atom.family((query: ListQuery) =>
  MailClient.runtime
    .atom(
      Effect.gen(function* () {
        yield* Effect.sleep("350 millis");
        const call = yield* MailClient;
        return yield* call("SearchServer", { query: { ...query, limit: SEARCH_LIMIT } });
      }),
    )
    .pipe(Atom.setIdleTTL("5 minutes")),
);

/**
 * The list on screen. Until a new query's first page arrives it keeps showing
 * the previous list. Write to it (no value) to load the next page.
 */
export const threadListAtom = Atom.writable(
  (get): ThreadList => {
    const query = get(listQueryAtom);
    const local = get(localQueryAtom);
    if (!query || !local) return EMPTY;
    const invalid = searchInputProblem(query.search ?? "");
    if (invalid) return { ...EMPTY, searchInputInvalid: invalid };
    const { loaded: loadedAtom, wanted } = pagedList(local);
    const result = get(loadedAtom);
    // A search shows no count, and counting one walks every match (1.7 s on 100k messages).
    // The count waits for the first rows: the main process answers in order, and All Mail's count
    // took 120-165 ms on a 20k-message database, ahead of the rows a switch was waiting for. Once
    // rows exist it stays mounted through refreshes, so a refresh counts once.
    const total =
      query.search === undefined && AsyncResult.value(result)._tag === "Some"
        ? AsyncResult.getOrElse(
            get(MailClient.query("ThreadCount", { query }, { reactivityKeys: [Keys.threads] })),
            () => null,
          )
        : null;
    const mediaCriteria = searchInputError(query.search ?? "")
      ? undefined
      : parseSearchQuery(query).criteria;
    const server =
      query.search === undefined || mediaCriteria?.image || mediaCriteria?.attachmentText
        ? null
        : get(serverList(query));
    const remote = server ? AsyncResult.getOrElse(server, () => null) : null;
    const serverState = {
      loadError: result._tag === "Failure",
      searchingServer: server !== null && (server._tag === "Initial" || server.waiting),
      searchTruncated: remote?.truncated ?? false,
      searchIgnored: remote?.ignored ?? [],
      searchInputInvalid: false as const,
      searchErrorAccounts: remote?.errors.map((e) => e.accountId) ?? [],
      searchReauthAccounts:
        remote?.errors.filter((e) => e.requiresReauth).map((e) => e.accountId) ?? [],
    };
    const liveRemote = remote
      ? get(
          MailClient.query(
            "Threads",
            {
              query: {
                ...query,
                messageIds: remote.threads.map((row) => row.id),
                limit: SEARCH_LIMIT,
                flat: query.flat ?? false,
                mailbox: query.searchScope === "folder" ? (query.mailbox ?? "inbox") : "all",
                ...(query.searchScope === "folder" && query.label ? { label: query.label } : {}),
              },
            },
            { reactivityKeys: [Keys.threads] },
          ),
        )
      : null;
    const remoteRows = liveRemote
      ? AsyncResult.getOrElse(liveRemote, () => remote?.threads ?? [])
      : [];
    const loaded = AsyncResult.value(result);
    if (loaded._tag === "None") {
      const shown = Option.getOrElse(get.self<ThreadList>(), () => EMPTY);
      return {
        ...shown,
        ...serverState,
        moreNotLoaded: null,
        // A failed server search has no rows; keep the previous ones until local rows arrive.
        threads: remoteRows.length > 0 ? remoteRows : shown.threads,
        loading: result._tag === "Initial",
        waiting: result.waiting,
        // The new query's first page, not an older one.
        loadingMore: false,
        canLoadMore: false,
      };
    }
    return {
      ...serverState,
      threads: remote
        ? mergeSearchResults(loaded.value.threads, remoteRows, query.flat)
        : loaded.value.threads,
      loading: false,
      waiting: result.waiting,
      // A refresh of the loaded pages is not an older page.
      loadingMore: result.waiting && get(wanted) > loaded.value.requested,
      moreNotLoaded:
        total === null ||
        query.search !== undefined ||
        query.mailbox === "drafts" ||
        remote?.truncated
          ? null
          : Math.max(0, total - loaded.value.threads.length),
      exhausted: loaded.value.done && (loaded.value.remoteDone ?? query.search !== undefined),
      canLoadMore:
        (!loaded.value.done ||
          (!query.search && !loaded.value.remoteDone && query.mailbox !== "drafts")) &&
        !result.waiting &&
        (total === null ||
          query.search !== undefined ||
          query.mailbox === "drafts" ||
          total > loaded.value.threads.length ||
          !loaded.value.remoteDone),
    };
  },
  (ctx, _next: void) => {
    const query = ctx.get(localQueryAtom);
    if (!query) return;
    const { wanted, loaded } = pagedList(query);
    const result = ctx.get(loaded);
    if (result._tag === "Failure" && !result.waiting) {
      ctx.set(wanted, ctx.get(wanted) + 1);
      return;
    }
    if (
      result._tag !== "Success" ||
      result.waiting ||
      (result.value.done && result.value.remoteDone)
    )
      return;
    ctx.set(wanted, ctx.get(wanted) + 1);
  },
);
