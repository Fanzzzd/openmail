/**
 * The window's route as atoms. The router owns navigation; app/location-bridge
 * copies each history change into `locationAtom`, and atoms that write the
 * location go through `historyAtom`, which main.tsx seeds with the router.
 * Without a router, as in tests that render parts of the app, writes only
 * update the atoms.
 */
import { Atom } from "effect/reactivity";
import {
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
  navigate(href: string, replace: boolean): void;
  back(): void;
  forward(): void;
}

const DEFAULT_HREF = mailHref(DEFAULT_VIEW);

/** A location for an href; anything that is not a route reads as the default view. */
export function locationOf(href: string): AppLocation {
  const route = parseAppHref(href);
  return route ? { href, route } : { href: DEFAULT_HREF, route: defaultMail };
}

type MailRoute = Extract<AppRoute, { kind: "mail" }>;
const defaultMail: MailRoute = { kind: "mail", view: DEFAULT_VIEW, state: {} };

const ignore = () => {
  /* No router: the atoms alone hold the location. */
};
const detached: AppHistory = { navigate: ignore, back: ignore, forward: ignore };

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
  if (settle(ctx, locationOf(href))) ctx.get(historyAtom).navigate(href, replace);
}

/** Moves the window to an href, as a new history entry. */
export const navigateAtom = Atom.writable(
  (get) => get(locationAtom).href,
  (ctx, href: string) => go(ctx, href, false),
);

/** The bridge's write: the router already moved to `href`. */
export const syncLocationAtom = Atom.writable(
  (get) => get(locationAtom),
  (ctx, href: string) => {
    settle(ctx, locationOf(href));
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
