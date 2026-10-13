import { reconcileProviderWrite, sameProviderWrite } from "../provider-write.js";
import { Effect, Schema, Option } from "effect";
import type { Account } from "../../domain/domain.js";
import { PermanentError, ProviderError, SettingsScopeMissing } from "../../domain/errors.js";
import { authFailure } from "../reauth.js";
import { graphTimestamp } from "../../calendar/graph-time.js";
import { escapeHtml } from "../../print.js";
import { htmlToText } from "../../mime/mime.js";
import {
  EMPTY_FILTER,
  RULE_IMPORTANCE,
  OutlookRulePredicates,
  filterDestinationsSupported,
  type FilterInput,
  type ServerFilter,
  type Vacation,
} from "../../domain/organization.js";
import {
  outlookConditions,
  outlookExceptions,
  outlookActions,
  validOutlookPredicates,
} from "./outlook-rules.js";

const Strings = Schema.optionalKey(Schema.Array(Schema.String));
const Recipients = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      emailAddress: Schema.Struct({
        address: Schema.String,
        name: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
);
const Predicates = Schema.Struct({
  ...OutlookRulePredicates.fields,
  senderContains: Strings,
  recipientContains: Strings,
  subjectContains: Strings,
  bodyOrSubjectContains: Strings,
  hasAttachments: Schema.optionalKey(Schema.Boolean),
  fromAddresses: Recipients,
  sentToAddresses: Recipients,
});
const Actions = Schema.Struct({
  markImportance: Schema.optionalKey(Schema.Literals(RULE_IMPORTANCE)),
  stopProcessingRules: Schema.optionalKey(Schema.Boolean),
  markAsRead: Schema.optionalKey(Schema.Boolean),
  delete: Schema.optionalKey(Schema.Boolean),
  moveToFolder: Schema.optionalKey(Schema.String),
  copyToFolder: Schema.optionalKey(Schema.String),
  assignCategories: Strings,
});
const ParsedGraphRule = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  conditions: Schema.optionalKey(Predicates),
  exceptions: Schema.optionalKey(Predicates),
  actions: Schema.optionalKey(Actions),
});
const GraphRule = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  conditions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  actions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  exceptions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  isReadOnly: Schema.optionalKey(Schema.Boolean),
});
const DateTime = Schema.Struct({ dateTime: Schema.String, timeZone: Schema.String });
const Replies = Schema.Struct({
  status: Schema.String,
  scheduledStartDateTime: Schema.optionalKey(DateTime),
  scheduledEndDateTime: Schema.optionalKey(DateTime),
  externalAudience: Schema.optionalKey(Schema.Literals(["none", "contactsOnly", "all"])),
  internalReplyMessage: Schema.optionalKey(Schema.String),
  externalReplyMessage: Schema.optionalKey(Schema.String),
});
const supportedPredicates = (raw: Readonly<Record<string, unknown>> | undefined) =>
  Object.entries(raw ?? {}).every(
    ([key, value]) =>
      Object.hasOwn(Predicates.fields, key) &&
      !["fromAddresses", "sentToAddresses"].includes(key) &&
      (!Array.isArray(value) || value.length <= 1) &&
      value !== false &&
      (key !== "withinSizeRange" ||
        (typeof value === "object" &&
          value !== null &&
          Object.keys(value).every((k) => ["minimumSize", "maximumSize"].includes(k)))),
  );

type RuleSizeRange = (typeof OutlookRulePredicates.Type)["withinSizeRange"];
const bothBounds = (range: RuleSizeRange) =>
  range?.minimumSize !== undefined && range.maximumSize !== undefined;
function legacySize(
  range: RuleSizeRange,
): Pick<FilterInput["criteria"], "size" | "sizeComparison"> {
  if (!range || bothBounds(range)) return {};
  if (range.minimumSize !== undefined)
    return { size: range.minimumSize * 1024, sizeComparison: "larger" };
  if (range.maximumSize !== undefined)
    return { size: range.maximumSize * 1024, sizeComparison: "smaller" };
  return {};
}
const unsupportedOutlookInput = (input: FilterInput) =>
  input.criteria.query ||
  input.action.star ||
  input.criteria.exceptAttachment === false ||
  !validOutlookPredicates(input.criteria.outlook) ||
  !validOutlookPredicates(input.criteria.outlookExceptions);
const outlookPredicates = (
  predicates: typeof Predicates.Type | undefined,
  useLegacySize = false,
) => {
  const result = Schema.decodeUnknownSync(OutlookRulePredicates)(predicates ?? {});
  if (useLegacySize && !bothBounds(result.withinSizeRange)) {
    const { withinSizeRange: _range, ...rest } = result;
    return rest;
  }
  return result;
};

function fromRule(r: typeof GraphRule.Type, archiveId: string | null = null): ServerFilter {
  const decoded = Schema.decodeUnknownOption(ParsedGraphRule)(r);
  if (Option.isNone(decoded))
    return { ...EMPTY_FILTER, id: r.id, name: r.displayName, editable: false };
  const parsed = decoded.value;
  const c = parsed.conditions;
  const action = {
    ...EMPTY_FILTER.action,
    ...(parsed.actions?.stopProcessingRules !== undefined
      ? { stopProcessing: parsed.actions.stopProcessingRules }
      : {}),
    markRead: parsed.actions?.markAsRead ?? false,
    ...(parsed.actions?.markImportance === "low"
      ? { markImportance: "low" as const }
      : parsed.actions?.markImportance
        ? { important: parsed.actions.markImportance === "high" }
        : {}),
    ...(parsed.actions?.copyToFolder ? { copyToFolder: parsed.actions.copyToFolder } : {}),
    ...(parsed.actions?.assignCategories
      ? { assignCategories: parsed.actions.assignCategories }
      : {}),
    trash: parsed.actions?.delete ?? false,
    archive: !!archiveId && parsed.actions?.moveToFolder === archiveId,
    label:
      parsed.actions?.moveToFolder === archiveId ? null : (parsed.actions?.moveToFolder ?? null),
  };
  const editable =
    filterDestinationsSupported(action, "outlook") &&
    !r.isReadOnly &&
    supportedPredicates(r.conditions) &&
    supportedPredicates(r.exceptions) &&
    validOutlookPredicates(c) &&
    validOutlookPredicates(parsed.exceptions) &&
    Object.keys(r.actions ?? {}).every((key) => Object.hasOwn(Actions.fields, key));
  const conditions = outlookPredicates(c, true);
  const exceptions = outlookPredicates(parsed.exceptions);
  return {
    id: r.id,
    ...(editable ? {} : { editable: false }),
    name: r.displayName,
    criteria: {
      ...EMPTY_FILTER.criteria,
      from:
        c?.senderContains?.join(" ") ??
        c?.fromAddresses?.map((a) => a.emailAddress.address).join(" ") ??
        "",
      to:
        c?.recipientContains?.join(" ") ??
        c?.sentToAddresses?.map((a) => a.emailAddress.address).join(" ") ??
        "",
      subject: c?.subjectContains?.join(" ") ?? "",
      ...(parsed.exceptions?.senderContains?.[0]
        ? { exceptFrom: parsed.exceptions.senderContains[0] }
        : {}),
      ...(parsed.exceptions?.recipientContains?.[0]
        ? { exceptTo: parsed.exceptions.recipientContains[0] }
        : {}),
      ...(parsed.exceptions?.subjectContains?.[0]
        ? { exceptSubject: parsed.exceptions.subjectContains[0] }
        : {}),
      ...(parsed.exceptions?.hasAttachments === true
        ? { exceptAttachment: parsed.exceptions.hasAttachments }
        : {}),
      query: "",
      ...(Object.keys(conditions).length ? { outlook: conditions } : {}),
      ...(Object.keys(exceptions).length ? { outlookExceptions: exceptions } : {}),
      hasAttachment: c?.hasAttachments ?? false,
      ...legacySize(c?.withinSizeRange),
      ...(c?.bodyOrSubjectContains?.length ? { hasWords: c.bodyOrSubjectContains.join(" ") } : {}),
      ...(parsed.exceptions?.bodyOrSubjectContains?.length
        ? { notWords: parsed.exceptions.bodyOrSubjectContains.join(" ") }
        : {}),
    },
    action,
  };
}

export function makeOutlookSettings<
  E extends {
    readonly _tag: string;
    readonly status?: number | undefined;
    readonly message?: string | undefined;
    readonly body?: string | undefined;
  },
>(
  get: <A>(id: string, schema: Schema.Decoder<A>, path: string) => Effect.Effect<A, E>,
  write: (
    id: string,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, E>,
) {
  const parseRule = (account: Account, raw: typeof GraphRule.Type) =>
    Effect.gen(function* () {
      const archiveId = raw.actions?.moveToFolder
        ? yield* get(
            account.id,
            Schema.Struct({ id: Schema.String }),
            "/me/mailFolders/archive?$select=id",
          ).pipe(
            Effect.map((folder) => folder.id),
            Effect.catchIf(
              (error) => error.status === 404,
              () => Effect.succeed(null),
            ),
          )
        : null;
      return fromRule(raw, archiveId);
    });
  const wrap = <A>(account: Account, effect: Effect.Effect<A, E | PermanentError>) =>
    effect.pipe(
      Effect.mapError((e) => {
        if (e._tag === "PermanentError")
          return new PermanentError({ message: e.message ?? "Unsupported rule" });
        if ("status" in e && e.status === 403)
          return new SettingsScopeMissing({
            accountId: account.id,
            message: "Sign in again to enable account settings",
          });
        const auth = authFailure(account.id, e);
        if (auth) return auth;
        return new ProviderError({
          message:
            e.message ?? ("body" in e ? e.body : undefined) ?? "Outlook settings request failed",
          ...("status" in e && e.status ? { status: e.status } : {}),
        });
      }),
    );
  const saveRule = (account: Account, input: FilterInput, id: string) =>
    Effect.gen(function* () {
      if (unsupportedOutlookInput(input))
        return yield* new PermanentError({
          message: "Outlook rules do not support search queries or starring",
        });
      const original = yield* get(
        account.id,
        GraphRule,
        `/me/mailFolders/inbox/messageRules/${encodeURIComponent(id)}`,
      );
      if ((yield* parseRule(account, original)).editable === false)
        return yield* new PermanentError({
          message: "This rule uses conditions or actions the editor cannot preserve",
        });
      const c = input.criteria;
      const archive = input.action.archive
        ? yield* get(
            account.id,
            Schema.Struct({ id: Schema.String }),
            "/me/mailFolders/archive?$select=id",
          )
        : null;
      const raw = yield* write(
        account.id,
        "PATCH",
        `/me/mailFolders/inbox/messageRules/${encodeURIComponent(id)}`,
        {
          displayName: input.name,
          conditions: outlookConditions(c),
          ...(original.exceptions || Object.keys(outlookExceptions(c)).length
            ? { exceptions: outlookExceptions(c) }
            : {}),
          actions: outlookActions(input.action, archive?.id ?? null),
        },
      );
      return yield* parseRule(
        account,
        yield* Schema.decodeUnknownEffect(GraphRule)(raw).pipe(Effect.orDie),
      );
    }).pipe((effect) => wrap(account, effect));
  return {
    updateFilter: (account: Account, id: string, input: FilterInput) =>
      saveRule(account, input, id),
    filters: (account: Account) =>
      wrap(
        account,
        get(
          account.id,
          Schema.Struct({ value: Schema.Array(GraphRule) }),
          "/me/mailFolders/inbox/messageRules",
        ).pipe(Effect.flatMap((r) => Effect.forEach(r.value, (raw) => parseRule(account, raw)))),
      ),
    createFilter: (account: Account, input: FilterInput) =>
      Effect.gen(function* () {
        // Graph rules have no Gmail query parser or flag action. Reject rather than create a broader rule.
        if (unsupportedOutlookInput(input))
          return yield* new PermanentError({
            message: "Outlook rules do not support search queries or starring",
          });
        const c = input.criteria;
        const existing = yield* get(
          account.id,
          Schema.Struct({ value: Schema.Array(Schema.Struct({ sequence: Schema.Number })) }),
          "/me/mailFolders/inbox/messageRules",
        );
        const archive = input.action.archive
          ? yield* get(
              account.id,
              Schema.Struct({ id: Schema.String }),
              "/me/mailFolders/archive?$select=id",
            )
          : null;
        const definition = {
          displayName: input.name,
          sequence: Math.max(0, ...existing.value.map((r) => r.sequence)) + 1,
          isEnabled: true,
          conditions: outlookConditions(c),
          ...(Object.keys(outlookExceptions(c)).length ? { exceptions: outlookExceptions(c) } : {}),
          actions: outlookActions(input.action, archive?.id ?? null),
        };
        const raw = yield* reconcileProviderWrite(
          write(account.id, "POST", "/me/mailFolders/inbox/messageRules", definition),
          get(
            account.id,
            Schema.Struct({ value: Schema.Array(GraphRule) }),
            "/me/mailFolders/inbox/messageRules",
          ).pipe(
            Effect.map((page) =>
              page.value.find((rule) =>
                sameProviderWrite(
                  {
                    displayName: rule.displayName,
                    conditions: rule.conditions ?? {},
                    exceptions: rule.exceptions ?? {},
                    actions: rule.actions ?? {},
                  },
                  {
                    displayName: definition.displayName,
                    conditions: definition.conditions,
                    exceptions: definition.exceptions ?? {},
                    actions: definition.actions,
                  },
                ),
              ),
            ),
          ),
        );
        return yield* parseRule(
          account,
          yield* Schema.decodeUnknownEffect(GraphRule)(raw).pipe(Effect.orDie),
        );
      }).pipe((effect) => wrap(account, effect)),
    deleteFilter: (account: Account, id: string) =>
      wrap(
        account,
        write(
          account.id,
          "DELETE",
          `/me/mailFolders/inbox/messageRules/${encodeURIComponent(id)}`,
        ).pipe(Effect.asVoid),
      ),
    vacation: (account: Account) =>
      wrap(
        account,
        get(account.id, Replies, "/me/mailboxSettings/automaticRepliesSetting").pipe(
          Effect.flatMap((v) =>
            Effect.try({
              try: (): Vacation => ({
                enabled: v.status !== "disabled",
                start:
                  v.status === "scheduled"
                    ? v.scheduledStartDateTime
                      ? graphTimestamp(v.scheduledStartDateTime)
                      : null
                    : null,
                end:
                  v.status === "scheduled"
                    ? v.scheduledEndDateTime
                      ? graphTimestamp(v.scheduledEndDateTime)
                      : null
                    : null,
                subject: "",
                body: htmlToText(v.externalReplyMessage ?? ""),
                contactsOnly: v.externalAudience === "contactsOnly",
                outlook: {
                  externalAudience: v.externalAudience ?? "none",
                  internalReplyMessage: v.internalReplyMessage ?? "",
                  externalReplyMessage: v.externalReplyMessage ?? "",
                },
              }),
              catch: (error) =>
                new PermanentError({
                  message: error instanceof Error ? error.message : "Invalid automatic reply dates",
                }),
            }),
          ),
        ),
      ),
    setVacation: (account: Account, v: Vacation) =>
      wrap(
        account,
        Effect.gen(function* () {
          const replies =
            v.outlook ??
            (yield* get(account.id, Replies, "/me/mailboxSettings/automaticRepliesSetting"));
          yield* write(account.id, "PATCH", "/me/mailboxSettings", {
            automaticRepliesSetting: {
              status: !v.enabled
                ? "disabled"
                : v.start !== null && v.end !== null
                  ? "scheduled"
                  : "alwaysEnabled",
              externalAudience: replies.externalAudience ?? "none",
              internalReplyMessage: replies.internalReplyMessage ?? "",
              externalReplyMessage:
                htmlToText(replies.externalReplyMessage ?? "") === v.body
                  ? (replies.externalReplyMessage ?? "")
                  : `<p>${escapeHtml(v.body).replaceAll("\n", "<br>")}</p>`,
              ...(v.start === null
                ? {}
                : {
                    scheduledStartDateTime: {
                      dateTime: new Date(v.start).toISOString().replace(/Z$/, ""),
                      timeZone: "UTC",
                    },
                  }),
              ...(v.end === null
                ? {}
                : {
                    scheduledEndDateTime: {
                      dateTime: new Date(v.end).toISOString().replace(/Z$/, ""),
                      timeZone: "UTC",
                    },
                  }),
            },
          });
        }),
      ),
    sendAs: (_account: Account) => Effect.succeed([]),
  };
}
