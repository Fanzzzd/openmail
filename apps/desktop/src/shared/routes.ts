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

/** The parts of the mail route that are not the view. */
export type MailState = Omit<MailSearch, "account" | "label">;

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
  // Keys in MailSearch order, so each route has one spelling.
  return `/mail/${segment(view.space)}/${segment(view.mailbox)}${stringifySearch(
    Object.fromEntries(
      Object.keys(MailSearch.fields).map((key) => [key, Reflect.get(search, key)]),
    ),
  )}`;
}

export const threadHref = (threadId: string, single = false) =>
  `/thread/${segment(threadId)}${single ? "?single=1" : ""}`;

export const composeHref = (draftId: string) => `/compose/${segment(draftId)}`;

export const isMailbox = Schema.is(MailboxView);

/** `accountId/labelId` is a label or folder; a bare id is a Gmail/Outlook category. */
function labelOf(raw: string | undefined): MailView["label"] {
  if (raw === undefined) return undefined;
  const slash = raw.indexOf("/");
  if (slash === -1) return { id: raw };
  if (slash === 0 || slash === raw.length - 1) return undefined;
  return { id: raw.slice(slash + 1), accountId: raw.slice(0, slash) };
}

/** The view a mail route names. An unknown mailbox falls back to the inbox. */
export function mailViewOf(space: string, mailbox: string, search: MailSearch): MailView {
  const label = labelOf(search.label);
  return {
    space: space || DEFAULT_VIEW.space,
    mailbox: isMailbox(mailbox) ? mailbox : DEFAULT_VIEW.mailbox,
    ...(search.account ? { accountId: search.account } : {}),
    ...(label ? { label } : {}),
  };
}

/** The route's state without empty values. */
export function mailStateOf({
  account: _account,
  label: _label,
  ...search
}: MailSearch): MailState {
  const state = { ...search };
  for (const key of Object.keys(state))
    if (!Reflect.get(state, key)) Reflect.deleteProperty(state, key);
  return state;
}

const decodeMailSearch = Schema.decodeUnknownSync(MailSearch);

/**
 * A router search validator. TanStack merges a route's validated search over
 * the raw params, so a dropped field is set to undefined here; otherwise the
 * raw invalid value would show through.
 */
function validator<S extends Schema.Decoder<object> & { readonly fields: Schema.Struct.Fields }>(
  schema: S,
) {
  const decode = Schema.decodeUnknownOption(schema);
  const empty = Schema.decodeUnknownSync(schema)({});
  const dropped = Object.fromEntries(Object.keys(schema.fields).map((key) => [key, undefined]));
  return (raw: unknown): S["Type"] => ({
    ...dropped,
    ...decode(raw).pipe(Option.getOrElse(() => empty)),
  });
}

export const validateMailSearch = validator(MailSearch);
export const validateThreadSearch = validator(ThreadSearch);

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
