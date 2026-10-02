import { richComposeBody } from "./compose-body.js";
import { Effect, Schema, Schedule } from "effect";
import type { Account } from "./domain.js";
import { AuthError, ProviderError, SettingsScopeMissing } from "./errors.js";
import { escapeHtml } from "./print.js";
import { htmlToText } from "./mime.js";
import {
  EMPTY_FILTER,
  filterDestinationsSupported,
  type FilterInput,
  type GmailRuleDefinition,
  type SendAs,
  type ServerFilter,
  type Vacation,
} from "./organization.js";

const ParsedGmailFilter = Schema.Struct({
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
const GmailFilter = Schema.Struct({
  id: Schema.String,
  criteria: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  action: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
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
  const parsed = Schema.decodeUnknownSync(ParsedGmailFilter)(raw);
  const add = parsed.action?.addLabelIds ?? [];
  const remove = parsed.action?.removeLabelIds ?? [];
  const action = {
    archive: remove.includes("INBOX"),
    markRead: remove.includes("UNREAD"),
    star: add.includes("STARRED"),
    trash: add.includes("TRASH"),
    label: add.find((l) => !["STARRED", "TRASH", "IMPORTANT", "INBOX"].includes(l)) ?? null,
  };
  const editable =
    filterDestinationsSupported(action, "gmail") &&
    Object.keys(raw.criteria ?? {}).every((key) =>
      ["from", "to", "subject", "query", "hasAttachment"].includes(key),
    ) &&
    Object.keys(raw.action ?? {}).every((key) => ["addLabelIds", "removeLabelIds"].includes(key)) &&
    (parsed.action?.removeLabelIds ?? []).every((id) => ["INBOX", "UNREAD"].includes(id)) &&
    !(parsed.action?.addLabelIds ?? []).some(
      (id) => !["STARRED", "TRASH"].includes(id) && !id.startsWith("Label_"),
    ) &&
    (parsed.action?.addLabelIds ?? []).filter((id) => !["STARRED", "TRASH"].includes(id)).length <=
      1;
  return {
    id: raw.id,
    ...(editable ? {} : { editable: false }),
    name: parsed.criteria?.from || parsed.criteria?.subject || parsed.criteria?.query || raw.id,
    criteria: { ...EMPTY_FILTER.criteria, ...parsed.criteria },
    action,
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
  const createFilter = (account: Account, input: FilterInput) => {
    const a = input.action;
    return wrap(
      account,
      write(account.id, "POST", "/settings/filters", {
        criteria: input.criteria,
        action: {
          addLabelIds: [
            ...(a.star ? ["STARRED"] : []),
            ...(a.trash ? ["TRASH"] : []),
            ...(a.label ? [a.label] : []),
          ],
          removeLabelIds: [...(a.archive ? ["INBOX"] : []), ...(a.markRead ? ["UNREAD"] : [])],
        },
      }).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(GmailFilter)(raw).pipe(Effect.orDie)),
      ),
    ).pipe(Effect.map(fromFilter));
  };
  const restoreFilter = (account: Account, definition: GmailRuleDefinition) =>
    wrap(
      account,
      write(account.id, "POST", "/settings/filters", definition).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(GmailFilter)(raw).pipe(Effect.orDie)),
      ),
    ).pipe(Effect.map(fromFilter));
  return {
    restoreFilter,
    updateFilter: (
      account: Account,
      id: string,
      input: FilterInput,
      onRestoreFailure?: (definition: GmailRuleDefinition) => Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const original = yield* wrap(
          account,
          get(account.id, GmailFilter, `/settings/filters/${encodeURIComponent(id)}`),
        );
        if (fromFilter(original).editable === false)
          return yield* new ProviderError({
            message: "This rule uses conditions or actions the editor cannot preserve",
          });
        yield* wrap(
          account,
          write(account.id, "DELETE", `/settings/filters/${encodeURIComponent(id)}`),
        );
        const result = yield* createFilter(account, input).pipe(Effect.result);
        if (result._tag === "Success") return result.success;
        const definition = { criteria: original.criteria, action: original.action };
        const restored = yield* restoreFilter(account, definition).pipe(
          Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 2 }),
          Effect.result,
        );
        if (restored._tag === "Failure" && onRestoreFailure) yield* onRestoreFailure(definition);
        return yield* new ProviderError({
          message:
            restored._tag === "Success"
              ? "Rule update failed. The previous rule was restored; reload the rule list before editing again."
              : "Rule update failed and automatic recovery failed. Use Restore rule to recover the saved original rule.",
        });
      }),
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
    createFilter,
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
                  signature: richComposeBody(a.signature ?? "").text,
                  signatureHtml: richComposeBody(a.signature ?? "").html,
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
