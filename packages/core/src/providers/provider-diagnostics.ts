import { Effect, Option, Schema } from "effect";
import type { HttpClientRequest } from "effect/http";
import { sha256Hex } from "../platform/crypto.js";

// Only fixed templates cross the logging boundary. Query parameters and resource ids never do.
const paths = [
  "/me",
  "/me/messages/:id",
  "/me/messages/:id/attachments/:id",
  "/me/messages/:id/$value",
  "/me/mailFolders/:id",
  "/me/mailFolders/:id/messageRules",
  "/me/mailboxSettings",
  "/me/contacts",
  "/me/people",
  "/me/calendarView",
  "/me/events",
  "/me/outlook/masterCategories",
  "/gmail/profile",
  "/gmail/messages/:id",
  "/gmail/threads/:id",
  "/gmail/labels/:id",
  "/gmail/settings/:feature",
  "/google/calendar/events",
  "/google/contacts",
  "/google/otherContacts",
  "/oauth/token",
  "/other",
] as const;
export const GraphSearchErrorCode = Schema.Literals([
  "ErrorInvalidProperty",
  "ErrorInvalidUrlQuery",
  "ErrorInvalidRequest",
  "BadRequest",
  "Request_BadRequest",
  "SearchQueryError",
  "InefficientFilter",
  "ErrorAccessDenied",
  "ErrorUnsupportedQuery",
  "ErrorItemNotFound",
  "InvalidAuthenticationToken",
  "TooManyRequests",
  "InvalidDeltaCursor",
  "unknown",
]);
const GraphError = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: GraphSearchErrorCode }) }),
);
export function graphSearchErrorCode(body: string): typeof GraphSearchErrorCode.Type {
  const result = Schema.decodeUnknownOption(GraphError)(body);
  return Option.isSome(result) ? result.value.error.code : "unknown";
}
export const ProviderDiagnostic = Schema.Struct({
  _tag: Schema.Literal("ProviderDiagnostic"),
  provider: Schema.Literals(["gmail", "outlook"]),
  method: Schema.Literals([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "TRACE",
    "CONNECT",
    "QUERY",
  ]),
  endpoint: Schema.Literals(paths),
  status: Schema.optionalKey(Schema.Number),
  failure: Schema.optionalKey(
    Schema.Literals(["http", "transport", "credentials", "configuration", "other"]),
  ),
  operation: Schema.optionalKey(Schema.Literals(["search", "delta"])),
  errorCode: Schema.optionalKey(GraphSearchErrorCode),
  accountHash: Schema.String,
});
export type ProviderDiagnostic = typeof ProviderDiagnostic.Type;

export function providerEndpoint(url: string): ProviderDiagnostic["endpoint"] {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (
    (parsed.hostname === "login.microsoftonline.com" ||
      parsed.hostname === "oauth2.googleapis.com") &&
    path.endsWith("/token")
  )
    return "/oauth/token";
  if (path.startsWith("/v1.0/")) {
    const graph = path.slice(5);
    for (const name of ["mailboxSettings", "contacts", "people", "calendarView", "events"] as const)
      if (graph === `/me/${name}` || graph.startsWith(`/me/${name}/`)) return `/me/${name}`;
    if (graph.startsWith("/me/outlook/masterCategories")) return "/me/outlook/masterCategories";
    if (/^\/me\/mailFolders\/[^/]+\/messageRules(?:\/|$)/.test(graph))
      return "/me/mailFolders/:id/messageRules";
    if (graph.startsWith("/me/mailFolders")) return "/me/mailFolders/:id";
    if (/^\/me\/messages\/[^/]+\/attachments/.test(graph))
      return "/me/messages/:id/attachments/:id";
    if (graph.endsWith("/$value")) return "/me/messages/:id/$value";
    if (graph.startsWith("/me/messages")) return "/me/messages/:id";
    if (graph === "/me") return "/me";
  }
  if (path.startsWith("/gmail/v1/users/me/")) {
    const gmail = path.slice("/gmail/v1/users/me/".length);
    if (gmail === "profile") return "/gmail/profile";
    for (const name of ["messages", "threads", "labels"] as const)
      if (gmail === name || gmail.startsWith(`${name}/`)) return `/gmail/${name}/:id`;
    if (gmail.startsWith("settings/")) return "/gmail/settings/:feature";
  }
  if (path.startsWith("/calendar/v3/")) return "/google/calendar/events";
  if (path.startsWith("/v1/people") || path.startsWith("/v1/contactGroups"))
    return "/google/contacts";
  if (path.startsWith("/v1/otherContacts")) return "/google/otherContacts";
  return "/other";
}

export function logProviderFailure(
  provider: ProviderDiagnostic["provider"],
  accountId: string,
  request: HttpClientRequest.HttpClientRequest,
  error: {
    readonly _tag?: string | undefined;
    readonly status?: number | undefined;
    readonly reason?: string | undefined;
    readonly deferred?: boolean | undefined;
  },
  search?: { readonly operation: "search"; readonly errorCode: typeof GraphSearchErrorCode.Type },
) {
  if (error.deferred) return Effect.void;
  return Effect.logWarning({
    _tag: "ProviderDiagnostic",
    provider,
    method: request.method,
    endpoint: providerEndpoint(request.url),
    ...search,
    ...(error.status === undefined ? {} : { status: error.status }),
    failure:
      error.reason === "configuration"
        ? "configuration"
        : error._tag === "AuthError"
          ? "credentials"
          : error.status === 0
            ? "transport"
            : error.status === undefined
              ? "other"
              : "http",
    accountHash: sha256Hex(accountId.toLowerCase()).slice(0, 16),
  } satisfies ProviderDiagnostic);
}

/** A denied optional endpoint stays disabled until that account signs in again. */
export function makeOptionalPermissions<
  E extends {
    readonly _tag: string;
    readonly status?: number | undefined;
    readonly body?: string | undefined;
  },
>() {
  const denied = new Map<string, E>();
  const optional = new Set<ProviderDiagnostic["endpoint"]>([
    "/me/mailboxSettings",
    "/me/mailFolders/:id/messageRules",
    "/me/contacts",
    "/me/people",
    "/me/calendarView",
    "/me/events",
    "/me/outlook/masterCategories",
    "/gmail/settings/:feature",
    "/google/calendar/events",
    "/google/contacts",
    "/google/otherContacts",
  ]);
  return {
    clear: () => denied.clear(),
    run: <A>(
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      effect: Effect.Effect<A, E>,
    ) =>
      Effect.suspend(() => {
        const endpoint = providerEndpoint(request.url);
        // Gmail settings scopes differ by feature; the fixed template still logs no path data.
        const feature =
          endpoint === "/gmail/settings/:feature"
            ? new URL(request.url).pathname.split("/")[6]
            : endpoint;
        const key = `${accountId}:${feature}`;
        const previous = denied.get(key);
        if (previous) return Effect.fail(previous);
        return effect.pipe(
          Effect.tapError((error) => {
            if (
              optional.has(endpoint) &&
              "status" in error &&
              error.status === 403 &&
              !/rateLimitExceeded|dailyLimitExceeded|SERVICE_DISABLED|accessNotConfigured|has not been used|API.*disabled/i.test(
                ("body" in error ? error.body : undefined) ?? "",
              )
            )
              denied.set(key, error);
            return Effect.void;
          }),
        );
      }),
  };
}

/** Never record a persisted cursor or its query, even when it fails validation. */
export const logInvalidGraphCursor = (accountId: string) =>
  Effect.logWarning({
    _tag: "ProviderDiagnostic",
    provider: "outlook",
    method: "GET",
    endpoint: "/me/mailFolders/:id",
    operation: "delta",
    errorCode: "InvalidDeltaCursor",
    failure: "other",
    accountHash: sha256Hex(accountId.toLowerCase()).slice(0, 16),
  } satisfies ProviderDiagnostic);
