/**
 * What the person is looking at: the view, list filters and search text.
 * The view and committed search live in the route (state/location.ts); these
 * atoms read and write it, because the thread list atom derives its query
 * from them.
 */
import { Atom } from "effect/reactivity";

import type { MailState } from "../../../shared/routes";
import type { View } from "../lib/view";
import { makeFolderFiltersAtom } from "./folder-filters";
import { goMail, mailRouteAtom, sameView } from "./location";

export { rememberedViewsAtom } from "./location";

/** A new view keeps the search and dialog, and closes the open thread. */
const keptForView = ({ q, scope, dialog }: MailState): MailState => ({
  ...(q ? { q } : {}),
  ...(scope ? { scope } : {}),
  ...(dialog ? { dialog } : {}),
});

/** The view on screen. Writing it adds a history entry, so Back returns to the previous view. */
export const viewAtom = Atom.writable(
  (get): View => get(mailRouteAtom).view,
  (ctx, view: View) =>
    goMail(
      ctx,
      (route) => ({ view, state: keptForView(route.state) }),
      sameView(ctx.get(mailRouteAtom).view, view),
    ),
).pipe(Atom.withEquality(sameView));

export const filtersAtom = makeFolderFiltersAtom(
  viewAtom,
  typeof localStorage === "undefined" ? undefined : localStorage,
);

/** Text typed since the last commit, and the committed search it started from. */
const searchDraftAtom = Atom.make<{ text: string; base: string } | undefined>(undefined).pipe(
  Atom.keepAlive,
);
const committedSearch = Atom.make((get) => get(mailRouteAtom).state.q ?? "");

/**
 * The search field's text. Typing stays in this window's atoms; the route's
 * `q` takes over again when it changes, as on Back.
 */
export const searchTextAtom = Atom.writable(
  (get) => {
    const draft = get(searchDraftAtom);
    const q = get(committedSearch);
    return draft?.base === q ? draft.text : q;
  },
  (ctx, text: string) => ctx.set(searchDraftAtom, { text, base: ctx.get(committedSearch) }),
);

export const searchAtom = Atom.make((get) => get(searchTextAtom).trim());

/** Writes the typed search into the route, replacing the current entry. */
export const commitSearchAtom = Atom.writable(
  (get) => get(committedSearch),
  (ctx) => {
    const text = ctx.get(searchTextAtom);
    const q = text.trim();
    goMail(
      ctx,
      ({ view, state: { q: _old, ...state } }) => ({
        view,
        state: { ...state, ...(q ? { q } : {}) },
      }),
      true,
    );
    ctx.set(searchDraftAtom, { text, base: q });
  },
);

/**
 * A map with insertion order as recency: setting a key makes it the newest,
 * and keys past `limit` are dropped oldest first. `undefined` removes the key.
 */
export function remember<V>(
  map: ReadonlyMap<string, V>,
  key: string,
  value: V | undefined,
  limit: number,
): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.delete(key);
  if (value !== undefined) next.set(key, value);
  for (const oldest of next.keys()) {
    if (next.size <= limit) break;
    next.delete(oldest);
  }
  return next;
}

/** Session state per key: one kept-alive map holds the `limit` most recently set keys,
 * and family members only derive from it, so unread members can be collected. */
function boundedFamily<V>(limit: number, empty: V) {
  const store = Atom.make<ReadonlyMap<string, V>>(new Map()).pipe(Atom.keepAlive);
  return Atom.family((key: string) =>
    Atom.writable(
      (get) => get(store).get(key) ?? empty,
      (ctx, value: V) =>
        ctx.set(store, remember(ctx.get(store), key, value === empty ? undefined : value, limit)),
    ),
  );
}

export const MESSAGE_BACKGROUND_LIMIT = 200;
export const IMAGES_LOADED_LIMIT = 100;

/**
 * The background picked with a message's toggle for the session; null follows
 * the preference.
 */
export const messageBackgroundAtom = boundedFamily<"light" | "dark" | null>(
  MESSAGE_BACKGROUND_LIMIT,
  null,
);

const NO_IMAGES_LOADED: ReadonlySet<string> = new Set<string>();

/**
 * Messages whose remote images were loaded by hand this session, keyed by
 * `readerThreadKey`, or by message id when conversations are off.
 */
export const imagesLoadedAtom = boundedFamily(IMAGES_LOADED_LIMIT, NO_IMAGES_LOADED);

/** Where search looks: every folder, or the folder on screen. */
export const searchScopeAtom = Atom.writable(
  (get): "all" | "folder" => get(mailRouteAtom).state.scope ?? "all",
  (ctx, scope: "all" | "folder") =>
    goMail(
      ctx,
      ({ view, state: { scope: _old, ...state } }) => ({
        view,
        state: { ...state, ...(scope === "folder" ? { scope } : {}) },
      }),
      true,
    ),
);
