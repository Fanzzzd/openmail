/**
 * The renderer's routes as strings. Main builds window URLs and Navigate
 * events with these builders, and the renderer's router uses the same search
 * format, so both sides agree on one href per screen. No router import: the
 * main process loads this file too.
 */
import { MailboxView } from "@openmail/core/schema";
import { Effect, Option, Schema } from "effect";

export const MAIL_DIALOGS = ["add", "settings", "proposals", "help", "feedback"] as const;
export type MailDialog = (typeof MAIL_DIALOGS)[number];

/** Hrefs and ids past these lengths are not ours. */
const MAX_HREF = 8192;
const MAX_VALUE = 2048;

/** What the mail route shows: the same shape as the renderer's View. */
export interface MailView {
  readonly space: string;
  readonly mailbox: MailboxView;
  readonly accountId?: string;
  readonly label?: { readonly id: string; readonly accountId?: string };
}

/** The parts of the mail route that are not the view. */
export interface MailState {
  readonly q?: string;
  readonly scope?: "all" | "folder";
  readonly thread?: string;
  readonly message?: string;
  readonly dialog?: MailDialog;
}

const Value = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_VALUE));
/** A field that fails to decode is dropped, so a bad link still opens the view it names. */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

/** The mail route's search params. Invalid fields fall back to their defaults. */
export const MailSearch = Schema.Struct({
  account: lenient(Value),
  /** `accountId/labelId` for a label or folder, or a bare Gmail/Outlook category. */
  label: lenient(Value),
  q: lenient(Schema.String.check(Schema.isMaxLength(MAX_VALUE))),
  scope: lenient(Schema.Literals(["all", "folder"])),
  thread: lenient(Value),
  message: lenient(Value),
  dialog: lenient(Schema.Literals(MAIL_DIALOGS)),
});
export type MailSearch = typeof MailSearch.Type;

/** The thread window's search params. */
export const ThreadSearch = Schema.Struct({
  single: Schema.optionalKey(Schema.Literal("1")).pipe(
    Schema.catchDecoding(() => Effect.succeedNone),
  ),
});
export type ThreadSearch = typeof ThreadSearch.Type;

export type AppRoute =
  | { readonly kind: "mail"; readonly view: MailView; readonly state: MailState }
  | { readonly kind: "thread"; readonly threadId: string; readonly single: boolean }
  | { readonly kind: "compose"; readonly draftId: string };

export const DEFAULT_VIEW: MailView = { space: "all", mailbox: "inbox" };

/** Search params as plain strings, in the order given. Empty and undefined values are left out. */
export function stringifySearch(search: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    if (typeof value === "string" && value !== "") params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Every value stays a string: ids such as "123" or "true" must not become numbers or booleans. */
export function parseSearch(search: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) result[key] ??= value;
  return result;
}

const segment = (value: string) => encodeURIComponent(value);

export function mailSearchOf(view: MailView, state: MailState = {}): MailSearch {
  return {
    ...(view.accountId ? { account: view.accountId } : {}),
    ...(view.label
      ? { label: view.label.accountId ? `${view.label.accountId}/${view.label.id}` : view.label.id }
      : {}),
    ...state,
  };
}

export function mailHref(view: MailView, state: MailState = {}): string {
  const search = mailSearchOf(view, state);
  return `/mail/${segment(view.space)}/${segment(view.mailbox)}${stringifySearch({
    account: search.account,
    label: search.label,
    q: search.q,
    scope: search.scope,
    thread: search.thread,
    message: search.message,
    dialog: search.dialog,
  })}`;
}

export const threadHref = (threadId: string, single = false) =>
  `/thread/${segment(threadId)}${single ? "?single=1" : ""}`;

export const composeHref = (draftId: string) => `/compose/${segment(draftId)}`;

const isMailbox = Schema.is(MailboxView);

/** The view a mail route names. An unknown mailbox falls back to the inbox. */
export function mailViewOf(space: string, mailbox: string, search: MailSearch): MailView {
  const slash = search.label?.indexOf("/") ?? -1;
  const label =
    search.label === undefined
      ? undefined
      : slash > 0 && slash < search.label.length - 1
        ? { id: search.label.slice(slash + 1), accountId: search.label.slice(0, slash) }
        : slash === -1
          ? { id: search.label }
          : undefined;
  return {
    space: space || DEFAULT_VIEW.space,
    mailbox: isMailbox(mailbox) ? mailbox : DEFAULT_VIEW.mailbox,
    ...(search.account ? { accountId: search.account } : {}),
    ...(label ? { label } : {}),
  };
}

export function mailStateOf(search: MailSearch): MailState {
  return {
    ...(search.q ? { q: search.q } : {}),
    ...(search.scope ? { scope: search.scope } : {}),
    ...(search.thread ? { thread: search.thread } : {}),
    ...(search.message ? { message: search.message } : {}),
    ...(search.dialog ? { dialog: search.dialog } : {}),
  };
}

const decodeMailSearch = Schema.decodeUnknownSync(MailSearch);

/**
 * The router's search validators. TanStack merges a route's validated search
 * over the raw params, so a dropped field is set to undefined here; otherwise
 * the raw invalid value would show through.
 */
export function validateMailSearch(raw: unknown): MailSearch {
  return {
    account: undefined,
    label: undefined,
    q: undefined,
    scope: undefined,
    thread: undefined,
    message: undefined,
    dialog: undefined,
    ...Schema.decodeUnknownOption(MailSearch)(raw).pipe(Option.getOrElse(() => ({}))),
  };
}

export function validateThreadSearch(raw: unknown): ThreadSearch {
  return {
    single: undefined,
    ...Schema.decodeUnknownOption(ThreadSearch)(raw).pipe(Option.getOrElse(() => ({}))),
  };
}

const hasControl = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

/**
 * Reads an in-app href such as `/mail/all/inbox?thread=x`. Anything else,
 * including absolute URLs, protocol-relative paths and unknown routes, is null,
 * so a Navigate href can only move between the app's own screens.
 */
export function parseAppHref(href: string): AppRoute | null {
  if (href.length > MAX_HREF || !href.startsWith("/") || href.startsWith("//")) return null;
  if (hasControl(href) || href.includes("\\") || href.includes("#")) return null;
  const query = href.indexOf("?");
  const path = query === -1 ? href : href.slice(0, query);
  const search = parseSearch(query === -1 ? "" : href.slice(query));
  const parts = path.slice(1).split("/");
  let decoded: string[];
  try {
    decoded = parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (decoded.some((part) => part === "" || part.length > MAX_VALUE || hasControl(part)))
    return null;
  const [kind, first, second] = decoded;
  if (kind === "mail" && first && second && decoded.length === 3) {
    if (!isMailbox(second)) return null;
    const mail = decodeMailSearch(search);
    return { kind: "mail", view: mailViewOf(first, second, mail), state: mailStateOf(mail) };
  }
  if (kind === "thread" && first && decoded.length === 2)
    return { kind: "thread", threadId: first, single: search.single === "1" };
  if (kind === "compose" && first && decoded.length === 2)
    return { kind: "compose", draftId: first };
  return null;
}

/** The href for a parsed route; parseAppHref(appHref(route)) gives the route back. */
export function appHref(route: AppRoute): string {
  if (route.kind === "mail") return mailHref(route.view, route.state);
  return route.kind === "thread"
    ? threadHref(route.threadId, route.single)
    : composeHref(route.draftId);
}
