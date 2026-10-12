import { restoredSelection } from "./window-selection";
/**
 * What the person is looking at: the view, list filters and search text.
 * They live in atoms because the thread list atom derives its query from them.
 */
import { Atom } from "effect/reactivity";

import { ALL, type SpaceId, type View } from "../lib/view";
import { makeFolderFiltersAtom } from "./folder-filters";

interface Nav {
  view: View;
  /** The last view in each space, so switching back lands where you were, like Arc. */
  remembered: ReadonlyMap<SpaceId, View>;
}

const restored = restoredSelection();
const nav = Atom.make<Nav>({
  view: restored ?? { space: ALL, mailbox: "inbox" },
  remembered: new Map(),
}).pipe(Atom.keepAlive);

/** The view on screen. Writing it also remembers it as its space's last view. */
export const viewAtom = Atom.writable(
  (get) => get(nav).view,
  (ctx, view: View) => {
    const remembered = new Map(ctx.get(nav).remembered).set(view.space, view);
    ctx.set(nav, { view, remembered });
  },
);

export const rememberedViewsAtom = Atom.make((get) => get(nav).remembered);

export const filtersAtom = makeFolderFiltersAtom(
  viewAtom,
  typeof localStorage === "undefined" ? undefined : localStorage,
);

export const searchTextAtom = Atom.make("").pipe(Atom.keepAlive);

export const searchAtom = Atom.make((get) => get(searchTextAtom).trim());

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

export const searchScopeAtom = Atom.make<"all" | "folder">("all").pipe(Atom.keepAlive);
