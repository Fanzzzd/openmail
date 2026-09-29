/**
 * The thread list, paged. A page is 100 threads older than the oldest one
 * already shown (`before`). Each list query keeps how many pages it wants and
 * what it has loaded; asking for one more page fetches only that page, and a
 * refresh (a change invalidated "threads") reloads every page on screen.
 */
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { ThreadQuery, ThreadSummary } from "../../../shared/api";
import type { AppError } from "../errors";
import { MailClient } from "../rpc";
import { OVERVIEW, scopeAccountIds } from "../view";
import { Keys } from "./keys";
import { accountsAtom } from "./queries";
import { filtersAtom, searchAtom, viewAtom } from "./ui";

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
  const scope = scopeAccountIds(view, accounts);
  const common = scope ? { accountIds: scope } : {};
  const search = get(searchAtom);
  if (search) return { ...common, search };
  const filters = get(filtersAtom);
  // Optional fields are left out rather than set to undefined: the main
  // process decodes the query strictly.
  return {
    ...common,
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
}

const EMPTY: ThreadList = { threads: [], loading: false, canLoadMore: false };

/**
 * The list on screen. Until a new query's first page arrives it keeps showing
 * the previous list. Write to it (no value) to load the next page.
 */
export const threadListAtom = Atom.writable(
  (get): ThreadList => {
    const query = get(listQueryAtom);
    if (!query) return EMPTY;
    const result = get(pagedList(query).loaded);
    const loaded = AsyncResult.value(result);
    if (loaded._tag === "None") {
      const shown = Option.getOrElse(get.self<ThreadList>(), () => EMPTY);
      return { ...shown, loading: result._tag === "Initial", canLoadMore: false };
    }
    return {
      threads: loaded.value.threads,
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
