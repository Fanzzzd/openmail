/**
 * The window's route as atoms. The router owns navigation; app/location-bridge
 * copies each history change into `locationAtom`, and atoms that write the
 * location go through `historyAtom`, which main.tsx seeds with the router.
 * Without a router, as in tests that render parts of the app, writes only
 * update the atoms.
 */
import { Atom } from "effect/reactivity";
import {
  appHref,
  type AppRoute,
  DEFAULT_VIEW,
  mailHref,
  type MailState,
  type MailView,
  parseAppHref,
} from "../../../shared/routes";

export interface AppLocation {
  readonly href: string;
  readonly route: AppRoute;
}

export interface AppHistory {
  /** A replace may wait until writes settle; a push writes at once. */
  navigate(href: string, replace: boolean): void;
  /** Writes a waiting replace now. */
  flush(): void;
  back(): void;
  forward(): void;
  /** The current entry's place in the session's history. A replace keeps it; Back lowers it. */
  index(): number;
  /** Adds an entry for `href`, the route already on screen, so Back returns to the entry before it. */
  pushSame(href: string): void;
  /** Runs `listener` after every history change, Back and Forward included. */
  listen(listener: (move: HistoryMove) => void): () => void;
}

/** How the current entry changed: a new entry, a rewrite of this one, or a step through history. */
export type HistoryMove = "push" | "replace" | "back" | "forward";

/** The route part of a history location. */
export const hrefOf = (location: { pathname: string; search: string }) =>
  `${location.pathname}${location.search}`;

const DEFAULT_HREF = mailHref(DEFAULT_VIEW);

/** A location for an href; anything that is not a route reads as the default view. */
export function locationOf(href: string): AppLocation {
  const route = parseAppHref(href);
  // One spelling per route, so the router's echo of a write compares equal.
  return route ? { href: appHref(route), route } : { href: DEFAULT_HREF, route: defaultMail };
}

type MailRoute = Extract<AppRoute, { kind: "mail" }>;
const defaultMail: MailRoute = { kind: "mail", view: DEFAULT_VIEW, state: {} };

const ignore = () => {
  /* No router: the atoms alone hold the location. */
};
const detached: AppHistory = {
  navigate: ignore,
  flush: ignore,
  back: ignore,
  forward: ignore,
  index: () => 0,
  pushSame: ignore,
  listen: () => ignore,
};

export const locationAtom = Atom.make<AppLocation>(locationOf(DEFAULT_HREF)).pipe(Atom.keepAlive);

export const historyAtom = Atom.make<AppHistory>(detached).pipe(Atom.keepAlive);

/** Insertion order is recency: the last entry is the view seen most recently. */
const rememberedAtom = Atom.make<ReadonlyMap<string, MailView>>(new Map()).pipe(Atom.keepAlive);

/** The last view in each space, so switching back lands where you were, like Arc. */
export const rememberedViewsAtom = Atom.make((get) => get(rememberedAtom));

type Ctx = Atom.WriteContext<unknown>;

function settle(ctx: Ctx, location: AppLocation) {
  if (ctx.get(locationAtom).href === location.href) return false;
  ctx.set(locationAtom, location);
  if (location.route.kind === "mail") {
    const view = location.route.view;
    const current = ctx.get(rememberedAtom);
    if ([...current.keys()].at(-1) === view.space && sameView(current.get(view.space), view))
      return true;
    const remembered = new Map(current);
    remembered.delete(view.space);
    ctx.set(rememberedAtom, remembered.set(view.space, view));
  }
  return true;
}

/**
 * Moves the window to `href`. The atoms change before the router commits, so
 * a second write in the same tick builds on the first.
 */
export function go(ctx: Ctx, href: string, replace: boolean) {
  const history = ctx.get(historyAtom);
  // A new entry first saves the waiting state of the one it leaves, so Back finds it.
  if (!replace) history.flush();
  if (settle(ctx, locationOf(href))) history.navigate(href, replace);
}

/** Moves the window to an href, as a new history entry. */
export const navigateAtom = Atom.writable(
  (get) => get(locationAtom).href,
  (ctx, href: string) => go(ctx, href, false),
);

/** Counts route changes that this window's atoms did not make: Back, Forward and redirects. */
export const outsideMovesAtom = Atom.make(0).pipe(Atom.keepAlive);

/** The bridge's write: the router already moved to `href`. */
export const syncLocationAtom = Atom.writable(
  (get) => get(locationAtom),
  (ctx, href: string) => {
    // The window's own writes reach here with the href the atoms already hold.
    if (settle(ctx, locationOf(href))) ctx.set(outsideMovesAtom, ctx.get(outsideMovesAtom) + 1);
  },
);

/** The mail route on screen; the default view in thread and compose windows. */
export const mailRouteAtom = Atom.make((get): MailRoute => {
  const { route } = get(locationAtom);
  return route.kind === "mail" ? route : defaultMail;
});

/**
 * Rewrites the mail route. Thread and compose windows ignore it, so a stray
 * write never turns them into the mail view.
 */
export function goMail(
  ctx: Ctx,
  next: (route: { view: MailView; state: MailState }) => { view: MailView; state: MailState },
  replace: boolean,
) {
  const { route } = ctx.get(locationAtom);
  if (route.kind !== "mail") return;
  const { view, state } = next(route);
  go(ctx, mailHref(view, state), replace);
}

export const sameView = (a: MailView | undefined, b: MailView | undefined) =>
  a === b || (a !== undefined && b !== undefined && mailHref(a) === mailHref(b));

/** Where `/` lands: the view seen most recently, or All inboxes. */
export function defaultHref(remembered: ReadonlyMap<string, MailView>): string {
  const last = [...remembered.values()].at(-1);
  return last ? mailHref(last) : DEFAULT_HREF;
}
