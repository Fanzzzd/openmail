import { reconcileProviderWrite, sameProviderWrite } from "../provider-write.js";
import { uncertainWrite } from "../provider-retry.js";
import { richComposeBody } from "../../compose/compose-body.js";
import { Effect, Schema, Option } from "effect";
import { CATEGORIES } from "../../domain/message.js";
import type { Account } from "../../domain/account.js";
import { ProviderError, SettingsScopeMissing } from "../../domain/errors.js";
import { authFailure } from "../reauth.js";
import { escapeHtml } from "../../reader/print.js";
import { htmlToText } from "../../mime/mime.js";
import {
  EMPTY_FILTER,
  GMAIL_REMOVABLE_SYSTEM_LABELS,
  gmailRuleLabels,
  filterDestinationsSupported,
  type FilterInput,
  type GmailRuleDefinition,
  type SendAs,
  type ServerFilter,
  type Vacation,
} from "../../domain/organization.js";

const ParsedGmailFilter = Schema.Struct({
  id: Schema.String,
  criteria: Schema.optionalKey(
    Schema.Struct({
      from: Schema.optionalKey(Schema.String),
      to: Schema.optionalKey(Schema.String),
      subject: Schema.optionalKey(Schema.String),
      query: Schema.optionalKey(Schema.String),
      hasAttachment: Schema.optionalKey(Schema.Boolean),
      excludeChats: Schema.optionalKey(Schema.Boolean),
      negatedQuery: Schema.optionalKey(Schema.String),
      size: Schema.optionalKey(Schema.Number),
      sizeComparison: Schema.optionalKey(Schema.Literals(["larger", "smaller", "unspecified"])),
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
  const decoded = Schema.decodeUnknownOption(ParsedGmailFilter)(raw);
  if (Option.isNone(decoded)) return { ...EMPTY_FILTER, id: raw.id, name: raw.id, editable: false };
  const parsed = decoded.value;
  const add = parsed.action?.addLabelIds ?? [];
  const remove = parsed.action?.removeLabelIds ?? [];
  const category = CATEGORIES.find((value) => add.includes(value));
  const { negatedQuery, sizeComparison, ...criteria } = parsed.criteria ?? {};
  const action = {
    archive: remove.includes("INBOX"),
    markRead: remove.includes("UNREAD"),
    star: add.includes("STARRED"),
    trash: add.includes("TRASH"),
    label: add.find((l) => l.startsWith("Label_")) ?? null,
    ...(add.filter((l) => l.startsWith("Label_")).length > 1
      ? { labels: add.filter((l) => l.startsWith("Label_")).slice(1) }
      : {}),
    ...(add.includes("IMPORTANT")
      ? { important: true }
      : remove.includes("IMPORTANT")
        ? { important: false }
        : {}),
    ...(category ? { category } : {}),
    addLabelIds: add.filter(
      (id) => !["STARRED", "TRASH", "IMPORTANT", category].includes(id) && !id.startsWith("Label_"),
    ),
    removeLabelIds: remove.filter(
      (id) => !GMAIL_REMOVABLE_SYSTEM_LABELS.some((label) => label === id),
    ),
  };
  const editable =
    filterDestinationsSupported(action, "gmail") &&
    sizeComparison !== "unspecified" &&
    Object.keys(raw.criteria ?? {}).every((key) =>
      [
        "from",
        "to",
        "subject",
        "query",
        "hasAttachment",
        "excludeChats",
        "negatedQuery",
        "size",
        "sizeComparison",
      ].includes(key),
    ) &&
    Object.keys(raw.action ?? {}).every((key) => ["addLabelIds", "removeLabelIds"].includes(key));
  return {
    id: raw.id,
    ...(editable ? {} : { editable: false }),
    name: parsed.criteria?.from || parsed.criteria?.subject || parsed.criteria?.query || raw.id,
    criteria: {
      ...EMPTY_FILTER.criteria,
      ...criteria,
      ...(sizeComparison && sizeComparison !== "unspecified" ? { sizeComparison } : {}),
      ...(negatedQuery ? { notWords: negatedQuery } : {}),
    },
    action,
  };
}

function normalizedGmailRule(rule: GmailRuleDefinition) {
  return {
    criteria: Object.fromEntries(
      Object.entries(rule.criteria ?? {}).filter(
        ([, value]) => value !== undefined && value !== "" && value !== false,
      ),
    ),
    action: rule.action ?? {},
  };
}
function sameGmailRule(left: GmailRuleDefinition, right: GmailRuleDefinition): boolean {
  return sameProviderWrite(normalizedGmailRule(left), normalizedGmailRule(right));
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
          !/SERVICE_DISABLED|accessNotConfigured|rateLimitExceeded|dailyLimitExceeded/i.test(
            e.body ?? "",
          )
        )
          return new SettingsScopeMissing({
            accountId: account.id,
            message: "Sign in again to enable account settings",
          });
        const auth = authFailure(account.id, e);
        if (auth) return auth;
        return new ProviderError({
          message: e.message ?? e.body ?? "Gmail settings request failed",
          ...(e.status !== undefined ? { status: e.status } : {}),
        });
      }),
    );
  const listDefinitions = (account: Account) =>
    get(
      account.id,
      Schema.NullOr(Schema.Struct({ filter: Schema.optionalKey(Schema.Array(GmailFilter)) })),
      "/settings/filters",
    );
  const createDefinition = (account: Account, definition: GmailRuleDefinition) =>
    reconcileProviderWrite(
      write(account.id, "POST", "/settings/filters", definition).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(GmailFilter)(raw).pipe(Effect.orDie)),
      ),
      listDefinitions(account).pipe(
        Effect.map((page) => page?.filter?.find((rule) => sameGmailRule(rule, definition))),
      ),
    );
  const createFilter = (account: Account, input: FilterInput) => {
    const a = input.action;
    const definition = {
      criteria: {
        from: input.criteria.from,
        to: input.criteria.to,
        subject: input.criteria.subject,
        hasAttachment: input.criteria.hasAttachment,
        ...(input.criteria.excludeChats !== undefined
          ? { excludeChats: input.criteria.excludeChats }
          : {}),
        query: input.criteria.hasWords
          ? [input.criteria.query, input.criteria.hasWords]
              .filter(Boolean)
              .map((q) => `(${q})`)
              .join(" ")
          : input.criteria.query,
        ...(input.criteria.notWords ? { negatedQuery: input.criteria.notWords } : {}),
        ...(input.criteria.size !== undefined
          ? { size: input.criteria.size, sizeComparison: input.criteria.sizeComparison }
          : {}),
      },
      action: gmailRuleLabels(a),
    };
    return wrap(account, createDefinition(account, definition)).pipe(Effect.map(fromFilter));
  };
  const restoreFilter = (account: Account, definition: GmailRuleDefinition) =>
    wrap(
      account,
      Effect.gen(function* () {
        const page = yield* listDefinitions(account);
        const existing = page?.filter?.find((rule) => sameGmailRule(rule, definition));
        return existing ?? (yield* createDefinition(account, definition));
      }),
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
        if (result.failure._tag !== "ProviderError") return yield* Effect.fail(result.failure);
        if (uncertainWrite(result.failure) || result.failure.status === undefined) {
          // The re-read did not establish whether creation succeeded. Restoring
          // here could install both old and new rules.
          if (onRestoreFailure)
            yield* onRestoreFailure({ criteria: original.criteria, action: original.action });
          return yield* new ProviderError({
            message:
              "Rule update is uncertain. Reload the rule list before restoring the saved original rule.",
          });
        }
        const definition = { criteria: original.criteria, action: original.action };
        const restored = yield* restoreFilter(account, definition).pipe(Effect.result);
        if (restored._tag === "Failure" && onRestoreFailure) yield* onRestoreFailure(definition);
        return yield* new ProviderError({
          message:
            restored._tag === "Success"
              ? "Filter update failed. The previous filter was restored; reload the filter list before editing again."
              : "Filter update failed and automatic recovery failed. Use Restore filter to recover the saved original filter.",
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
