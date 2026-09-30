/**
 * The thread list, paged. A page is 100 threads older than the oldest one
 * already shown (`before`). Each list query keeps how many pages it wants and
 * what it has loaded; asking for one more page fetches only that page, and a
 * refresh (a change invalidated "threads") reloads every page on screen.
 */
import { DEFAULT_PREFS, mergeSearchResults } from "@openmail/core/schema";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { ThreadQuery, ThreadSummary } from "../../../shared/api";
import type { AppError } from "../errors";
import { MailClient } from "../rpc";
import { OVERVIEW, scopeAccountIds } from "../view";
import { Keys } from "./keys";
import { accountsAtom, organizationAtom, prefsAtom } from "./queries";
import { filtersAtom, searchAtom, searchScopeAtom, viewAtom } from "./ui";

const PAGE = 100;
/** Search results come as one page. */
const SEARCH_LIMIT = 200;

/** A thread query without its page cursor and size. */
export type ListQuery = Omit<ThreadQuery, "before" | "limit">;

interface Loaded {
  threads: readonly ThreadSummary[];
  pages: number;
  /** The last page came back short: there is nothing older. */
  done: boolean;
}

/** Fetches pages until `wanted` are loaded, continuing from `from` when given. */
const loadPages = (query: ListQuery, wanted: number, from: Loaded | undefined) =>
  Effect.gen(function* () {
    const call = yield* MailClient;
    const limit = query.search ? SEARCH_LIMIT : PAGE;
    let { threads, pages, done } = from ?? { threads: [], pages: 0, done: false };
    while (pages < wanted && !done) {
      const oldest = threads.at(-1);
      const page = yield* call("Threads", {
        query: { ...query, ...(oldest ? { before: oldest.date } : {}), limit },
      });
      threads = [...threads, ...page];
      pages += 1;
      done = query.search !== undefined || page.length < limit;
    }
    return { threads, pages, done } satisfies Loaded;
  });

const pagedList = Atom.family((query: ListQuery) => {
  const wanted = Atom.make(1);
  const loaded = MailClient.runtime
    .atom((get) => {
      const want = get(wanted);
      const previous = get
        .self<AsyncResult.AsyncResult<Loaded, AppError>>()
        .pipe(Option.flatMap(AsyncResult.value), Option.getOrUndefined);
      // One more page than last time keeps what is loaded; anything else is a refresh.
      return loadPages(query, want, previous?.pages === want - 1 ? previous : undefined);
    })
    .pipe(Atom.withReactivity([Keys.threads]), Atom.setIdleTTL("5 minutes"));
  return { wanted, loaded };
});

/** The query behind the list on screen; null on the overview, which has no list. */
export const listQueryAtom = Atom.make((get): ListQuery | null => {
  const view = get(viewAtom);
  if (view.space === OVERVIEW) return null;
  const accounts = AsyncResult.getOrElse(get(accountsAtom), () => []);
  const baseScope = scopeAccountIds(view, accounts);
  const organization = AsyncResult.getOrElse(get(organizationAtom), () => []);
  const scope = view.label?.id.startsWith("CATEGORY_")
    ? accounts
        .filter(
          (a) =>
            a.provider === "gmail" &&
            (!baseScope || baseScope.includes(a.id)) &&
            organization.find((o) => o.accountId === a.id)?.categories !== false,
        )
        .map((a) => a.id)
    : baseScope;
  const common = scope ? { accountIds: scope } : {};
  const search = get(searchAtom);
  if (search)
    return {
      ...common,
      search,
      searchScope: get(searchScopeAtom),
      mailbox: view.mailbox,
      ...(view.label ? { label: view.label.id } : {}),
      flat: !AsyncResult.getOrElse(get(prefsAtom), () => DEFAULT_PREFS).threadGrouping,
    };
  const filters = get(filtersAtom);
  const grouping = AsyncResult.getOrElse(get(prefsAtom), () => DEFAULT_PREFS).threadGrouping;
  // Optional fields are left out rather than set to undefined: the main
  // process decodes the query strictly.
  return {
    ...common,
    ...(grouping ? {} : { flat: true }),
    mailbox: view.mailbox,
    ...(view.label ? { label: view.label.id } : {}),
    ...(filters.unread ? { unreadOnly: true } : {}),
    ...(filters.starred ? { starredOnly: true } : {}),
  };
});

export interface ThreadList {
  threads: readonly ThreadSummary[];
  /** No result for this query yet; `threads` may still be the previous view's. */
  loading: boolean;
  /** Older threads exist and no page is in flight. */
  canLoadMore: boolean;
  searchingServer: boolean;
  searchTruncated: boolean;
  searchErrors: readonly string[];
}

const EMPTY: ThreadList = {
  threads: [],
  loading: false,
  canLoadMore: false,
  searchingServer: false,
  searchTruncated: false,
  searchErrors: [],
};

// Separate request: local hits can render while the network is in flight.
const serverList = Atom.family((query: ListQuery) =>
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
    if (!query) return EMPTY;
    const result = get(pagedList(query).loaded);
    const server = query.search === undefined ? null : get(serverList(query));
    const remote = server ? AsyncResult.getOrElse(server, () => null) : null;
    const serverState = {
      searchingServer: server !== null && (server._tag === "Initial" || server.waiting),
      searchTruncated: remote?.truncated ?? false,
      searchErrors: remote?.errors.map((e) => `${e.accountId}: ${e.message}`) ?? [],
    };
    const liveRemote = remote
      ? get(
          MailClient.query(
            "Threads",
            {
              query: {
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
        threads: remote ? remoteRows : shown.threads,
        loading: result._tag === "Initial",
        canLoadMore: false,
      };
    }
    return {
      ...serverState,
      threads: remote
        ? mergeSearchResults(loaded.value.threads, remoteRows, query.flat)
        : loaded.value.threads,
      loading: false,
      canLoadMore: !loaded.value.done && !result.waiting,
    };
  },
  (ctx, _next: void) => {
    const query = ctx.get(listQueryAtom);
    if (!query) return;
    const { wanted, loaded } = pagedList(query);
    const result = ctx.get(loaded);
    if (result._tag === "Success" && !result.waiting && !result.value.done) {
      ctx.set(wanted, ctx.get(wanted) + 1);
    }
  },
);
