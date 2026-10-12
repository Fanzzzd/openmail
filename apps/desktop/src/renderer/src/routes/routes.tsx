/**
 * The window's screens. Code-based routes: four routes do not need the
 * generated tree, and route-level code splitting would fight the chunks that
 * tests/bundle-split.test.ts checks.
 */
import {
  createRootRouteWithContext,
  createRoute,
  Navigate,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { mailHref, validateMailSearch, validateThreadSearch } from "../../../shared/routes";
import { App } from "../app/App";
import { ThreadWindow } from "../app/ThreadWindow";
import { MailboxView } from "@openmail/core/schema";

export interface RouterContext {
  /** Where `/` lands: the remembered view, or All inboxes. */
  readonly defaultHref: () => string;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => <Navigate to="/" replace />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- TanStack redirects are thrown objects.
    throw redirect({ href: context.defaultHref(), replace: true });
  },
});

const isMailbox = Schema.is(MailboxView);

export const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "mail/$space/$mailbox",
  validateSearch: validateMailSearch,
  beforeLoad: ({ params }) => {
    if (!isMailbox(params.mailbox))
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack redirects are thrown objects.
      throw redirect({ href: mailHref({ space: params.space, mailbox: "inbox" }), replace: true });
  },
  component: MailScreen,
});

export const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "thread/$threadId",
  validateSearch: validateThreadSearch,
  component: ThreadScreen,
});

export const composeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "compose/$draftId",
  component: ComposeScreen,
});

export const routeTree = rootRoute.addChildren([indexRoute, mailRoute, threadRoute, composeRoute]);

function MailScreen() {
  return <App />;
}

function ThreadScreen() {
  const { threadId } = threadRoute.useParams();
  const { single } = threadRoute.useSearch();
  return <ThreadWindow id={threadId} single={single === "1"} />;
}

function ComposeScreen() {
  const { draftId } = composeRoute.useParams();
  return <App composeId={draftId} />;
}
