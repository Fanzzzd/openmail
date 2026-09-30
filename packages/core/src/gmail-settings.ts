import { Effect, Schema } from "effect";
import type { Account } from "./domain.js";
import { AuthError, ProviderError, SettingsScopeMissing } from "./errors.js";
import { escapeHtml } from "./print.js";
import { htmlToText } from "./mime.js";
import {
  EMPTY_FILTER,
  type FilterInput,
  type SendAs,
  type ServerFilter,
  type Vacation,
} from "./organization.js";

const GmailFilter = Schema.Struct({
  id: Schema.String,
  criteria: Schema.optionalKey(
    Schema.Struct({
      from: Schema.optionalKey(Schema.String),
      to: Schema.optionalKey(Schema.String),
      subject: Schema.optionalKey(Schema.String),
      query: Schema.optionalKey(Schema.String),
      hasAttachment: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  action: Schema.optionalKey(
    Schema.Struct({
      addLabelIds: Schema.optionalKey(Schema.Array(Schema.String)),
      removeLabelIds: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
const GmailVacation = Schema.Struct({
  enableAutoReply: Schema.optionalKey(Schema.Boolean),
  responseSubject: Schema.optionalKey(Schema.String),
  responseBodyPlainText: Schema.optionalKey(Schema.String),
  responseBodyHtml: Schema.optionalKey(Schema.String),
  restrictToContacts: Schema.optionalKey(Schema.Boolean),
  startTime: Schema.optionalKey(Schema.String),
  endTime: Schema.optionalKey(Schema.String),
});
const Aliases = Schema.Struct({
  sendAs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        sendAsEmail: Schema.String,
        displayName: Schema.optionalKey(Schema.String),
        isDefault: Schema.optionalKey(Schema.Boolean),
        signature: Schema.optionalKey(Schema.String),
        verificationStatus: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

function fromFilter(raw: typeof GmailFilter.Type): ServerFilter {
  const add = raw.action?.addLabelIds ?? [];
  const remove = raw.action?.removeLabelIds ?? [];
  return {
    id: raw.id,
    name: raw.criteria?.from || raw.criteria?.subject || raw.criteria?.query || raw.id,
    criteria: { ...EMPTY_FILTER.criteria, ...raw.criteria },
    action: {
      archive: remove.includes("INBOX"),
      markRead: remove.includes("UNREAD"),
      star: add.includes("STARRED"),
      trash: add.includes("TRASH"),
      label: add.find((l) => !["STARRED", "TRASH", "IMPORTANT", "INBOX"].includes(l)) ?? null,
    },
  };
}

/** settings errors stay separate from the authentication state used by mail sync. */
export function makeGmailSettings<
  E extends {
    readonly _tag: string;
    readonly status?: number | undefined;
    readonly message?: string | undefined;
    readonly body?: string | undefined;
  },
>(
  get: <A>(accountId: string, schema: Schema.Decoder<A>, path: string) => Effect.Effect<A, E>,
  write: (
    accountId: string,
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, E>,
) {
  const missingSendAsScopes = new Map<string, SettingsScopeMissing>();
  const wrap = <A>(account: Account, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((e) => {
        if (
          e.status === 403 &&
          (!e.body?.trim() || /insufficient|scope|permission|forbidden/i.test(e.body)) &&
          !/SERVICE_DISABLED|accessNotConfigured|rateLimitExceeded|dailyLimitExceeded/i.test(
            e.body ?? "",
          )
        )
          return new SettingsScopeMissing({
            accountId: account.id,
            message: "Sign in again to enable account settings",
          });
        if (e._tag === "AuthError" || e.status === 401)
          return new AuthError({ accountId: account.id, message: e.message ?? "Sign in again" });
        return new ProviderError({
          message: e.message ?? e.body ?? "Gmail settings request failed",
          ...(e.status ? { status: e.status } : {}),
        });
      }),
    );
  return {
    clearMissingScopes: (accountId: string) => missingSendAsScopes.delete(accountId),
    filters: (account: Account) =>
      wrap(
        account,
        get(
          account.id,
          Schema.NullOr(Schema.Struct({ filter: Schema.optionalKey(Schema.Array(GmailFilter)) })),
          "/settings/filters",
        ).pipe(Effect.map((r) => (r?.filter ?? []).map(fromFilter))),
      ),
    createFilter: (account: Account, input: FilterInput) => {
      const a = input.action;
      const addLabelIds = [
        ...(a.star ? ["STARRED"] : []),
        ...(a.trash ? ["TRASH"] : []),
        ...(a.label ? [a.label] : []),
      ];
      const removeLabelIds = [...(a.archive ? ["INBOX"] : []), ...(a.markRead ? ["UNREAD"] : [])];
      return wrap(
        account,
        write(account.id, "POST", "/settings/filters", {
          criteria: input.criteria,
          action: { addLabelIds, removeLabelIds },
        }).pipe(
          Effect.flatMap((raw) => Schema.decodeUnknownEffect(GmailFilter)(raw).pipe(Effect.orDie)),
        ),
      ).pipe(Effect.map(fromFilter));
    },
    deleteFilter: (account: Account, id: string) =>
      wrap(
        account,
        write(account.id, "DELETE", `/settings/filters/${encodeURIComponent(id)}`).pipe(
          Effect.asVoid,
        ),
      ),
    vacation: (account: Account) =>
      wrap(
        account,
        get(account.id, GmailVacation, "/settings/vacation").pipe(
          Effect.map((v): Vacation => ({
            enabled: v.enableAutoReply ?? false,
            start: v.startTime ? Number(v.startTime) : null,
            end: v.endTime ? Number(v.endTime) : null,
            subject: v.responseSubject ?? "",
            body: v.responseBodyPlainText ?? htmlToText(v.responseBodyHtml ?? ""),
            contactsOnly: v.restrictToContacts ?? false,
            ...(v.responseBodyHtml === undefined
              ? {}
              : {
                  gmail: {
                    responseBodyHtml: v.responseBodyHtml,
                    originalBody: v.responseBodyPlainText ?? htmlToText(v.responseBodyHtml),
                  },
                }),
          })),
        ),
      ),
    setVacation: (account: Account, v: Vacation) =>
      wrap(
        account,
        Effect.gen(function* () {
          const current = v.gmail
            ? null
            : yield* get(account.id, GmailVacation, "/settings/vacation");
          const rich =
            v.gmail ??
            (current?.responseBodyHtml === undefined
              ? undefined
              : {
                  responseBodyHtml: current.responseBodyHtml,
                  originalBody:
                    current.responseBodyPlainText ?? htmlToText(current.responseBodyHtml),
                });
          yield* write(account.id, "PUT", "/settings/vacation", {
            enableAutoReply: v.enabled,
            responseSubject: v.subject,
            responseBodyPlainText: v.body,
            restrictToContacts: v.contactsOnly,
            ...(rich
              ? {
                  responseBodyHtml:
                    rich.originalBody === v.body
                      ? rich.responseBodyHtml
                      : `<p>${escapeHtml(v.body).replaceAll("\n", "<br>")}</p>`,
                }
              : {}),
            ...(v.start === null ? {} : { startTime: String(v.start) }),
            ...(v.end === null ? {} : { endTime: String(v.end) }),
          });
        }),
      ),
    sendAs: (account: Account) =>
      Effect.suspend(() => {
        const missing = missingSendAsScopes.get(account.id);
        if (missing) return Effect.fail(missing);
        return wrap(
          account,
          get(account.id, Schema.NullOr(Aliases), "/settings/sendAs").pipe(
            Effect.map((r): SendAs[] =>
              (r?.sendAs ?? [])
                .filter(
                  (a) =>
                    a.verificationStatus === "accepted" ||
                    a.sendAsEmail.toLowerCase() === account.email.toLowerCase(),
                )
                .map((a) => ({
                  accountId: account.id,
                  address: a.sendAsEmail,
                  name: a.displayName ?? "",
                  isDefault: a.isDefault ?? false,
                  signature: htmlToText(a.signature ?? ""),
                })),
            ),
          ),
        ).pipe(
          Effect.tapError((error) =>
            error._tag === "SettingsScopeMissing"
              ? Effect.sync(() => {
                  missingSendAsScopes.set(account.id, error);
                })
              : Effect.void,
          ),
        );
      }),
  };
}
