import { restoredSelection } from "../window-selection";
/**
 * What the person is looking at: the view, list filters and search text.
 * They live in atoms because the thread list atom derives its query from them.
 */
import { Atom } from "effect/reactivity";

import { ALL, type SpaceId, type View } from "../view";
import { makeFolderFiltersAtom } from "./folder-filters";
export { NO_FILTERS } from "./folder-filters";

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

/** Where each space was left. */
export const rememberedViewsAtom = Atom.make((get) => get(nav).remembered);

export const filtersAtom = makeFolderFiltersAtom(
  viewAtom,
  typeof localStorage === "undefined" ? undefined : localStorage,
);

/** The search field as typed. */
export const searchTextAtom = Atom.make("").pipe(Atom.keepAlive);

/** The search the list runs; empty means no search. */
export const searchAtom = Atom.make((get) => get(searchTextAtom).trim());

/**
 * The background picked with a message's toggle for the session; null follows
 * the preference.
 */
export const messageBackgroundAtom = Atom.family((_messageId: string) =>
  Atom.make<"light" | "dark" | null>(null).pipe(Atom.keepAlive),
);

/**
 * Messages whose remote images were loaded by hand this session, keyed by
 * `readerThreadKey`, or by message id when conversations are off.
 */
export const imagesLoadedAtom = Atom.family((_key: string) =>
  Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive),
);

export const searchScopeAtom = Atom.make<"all" | "folder">("all").pipe(Atom.keepAlive);
