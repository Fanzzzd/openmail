import { Effect, Schema } from "effect";
import type { Account } from "./domain.js";
import { AuthError, PermanentError, ProviderError, SettingsScopeMissing } from "./errors.js";
import { graphTimestamp } from "./graph-time.js";
import { escapeHtml } from "./print.js";
import { htmlToText } from "./mime.js";
import {
  EMPTY_FILTER,
  filterDestinationsSupported,
  type FilterInput,
  type ServerFilter,
  type Vacation,
} from "./organization.js";

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
const ParsedGraphRule = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  conditions: Schema.optionalKey(
    Schema.Struct({
      senderContains: Strings,
      recipientContains: Strings,
      subjectContains: Strings,
      bodyContains: Strings,
      bodyOrSubjectContains: Strings,
      withinSizeRange: Schema.optionalKey(
        Schema.Struct({
          minimumSize: Schema.optionalKey(Schema.Number),
          maximumSize: Schema.optionalKey(Schema.Number),
        }),
      ),
      hasAttachments: Schema.optionalKey(Schema.Boolean),
      fromAddresses: Recipients,
      sentToAddresses: Recipients,
    }),
  ),
  exceptions: Schema.optionalKey(
    Schema.Struct({
      bodyOrSubjectContains: Strings,
      senderContains: Strings,
      recipientContains: Strings,
      subjectContains: Strings,
      hasAttachments: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  actions: Schema.optionalKey(
    Schema.Struct({
      markImportance: Schema.optionalKey(Schema.Literals(["high", "normal", "low"])),
      stopProcessingRules: Schema.optionalKey(Schema.Boolean),
      markAsRead: Schema.optionalKey(Schema.Boolean),
      delete: Schema.optionalKey(Schema.Boolean),
      moveToFolder: Schema.optionalKey(Schema.String),
    }),
  ),
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
function fromRule(r: typeof GraphRule.Type, archiveId: string | null = null): ServerFilter {
  const parsed = Schema.decodeUnknownSync(ParsedGraphRule)(r);
  const c = parsed.conditions;
  const action = {
    ...EMPTY_FILTER.action,
    ...(parsed.actions?.stopProcessingRules !== undefined
      ? { stopProcessing: parsed.actions.stopProcessingRules }
      : {}),
    markRead: parsed.actions?.markAsRead ?? false,
    ...(parsed.actions?.markImportance
      ? { important: parsed.actions.markImportance === "high" }
      : {}),
    trash: parsed.actions?.delete ?? false,
    archive: !!archiveId && parsed.actions?.moveToFolder === archiveId,
    label:
      parsed.actions?.moveToFolder === archiveId ? null : (parsed.actions?.moveToFolder ?? null),
  };
  const editable =
    filterDestinationsSupported(action, "outlook") &&
    !r.isReadOnly &&
    parsed.actions?.markImportance !== "low" &&
    Object.keys(r.exceptions ?? {}).every((key) =>
      [
        "bodyOrSubjectContains",
        "senderContains",
        "recipientContains",
        "subjectContains",
        "hasAttachments",
      ].includes(key),
    ) &&
    [
      parsed.exceptions?.bodyOrSubjectContains,
      parsed.exceptions?.senderContains,
      parsed.exceptions?.recipientContains,
      parsed.exceptions?.subjectContains,
    ].every((values) => !values || values.length <= 1) &&
    !(
      c?.withinSizeRange?.minimumSize !== undefined && c.withinSizeRange.maximumSize !== undefined
    ) &&
    Object.keys(r.conditions ?? {}).every((key) =>
      [
        "senderContains",
        "recipientContains",
        "subjectContains",
        "hasAttachments",
        "bodyOrSubjectContains",
        "withinSizeRange",
      ].includes(key),
    ) &&
    Object.keys(r.actions ?? {}).every((key) =>
      ["markAsRead", "delete", "moveToFolder", "markImportance", "stopProcessingRules"].includes(
        key,
      ),
    ) &&
    [c?.senderContains, c?.recipientContains, c?.subjectContains, c?.bodyOrSubjectContains].every(
      (values) => !values || values.length <= 1,
    );
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
      query: c?.bodyContains?.join(" ") ?? "",
      hasAttachment: c?.hasAttachments ?? false,
      ...(c?.bodyOrSubjectContains?.length ? { hasWords: c.bodyOrSubjectContains.join(" ") } : {}),
      ...(parsed.exceptions?.bodyOrSubjectContains?.length
        ? { notWords: parsed.exceptions.bodyOrSubjectContains.join(" ") }
        : {}),
      ...(c?.withinSizeRange?.minimumSize !== undefined
        ? { size: c.withinSizeRange.minimumSize * 1024, sizeComparison: "larger" }
        : c?.withinSizeRange?.maximumSize !== undefined
          ? { size: c.withinSizeRange.maximumSize * 1024, sizeComparison: "smaller" }
          : {}),
    },
    action,
  };
}

const ruleExceptions = (criteria: FilterInput["criteria"]) => ({
  ...(criteria.notWords ? { bodyOrSubjectContains: [criteria.notWords] } : {}),
  ...(criteria.exceptFrom ? { senderContains: [criteria.exceptFrom] } : {}),
  ...(criteria.exceptTo ? { recipientContains: [criteria.exceptTo] } : {}),
  ...(criteria.exceptSubject ? { subjectContains: [criteria.exceptSubject] } : {}),
  ...(criteria.exceptAttachment === true ? { hasAttachments: true } : {}),
});
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
        if (e._tag === "AuthError" || ("status" in e && e.status === 401))
          return new AuthError({ accountId: account.id, message: e.message ?? "Sign in again" });
        return new ProviderError({
          message:
            e.message ?? ("body" in e ? e.body : undefined) ?? "Outlook settings request failed",
          ...("status" in e && e.status ? { status: e.status } : {}),
        });
      }),
    );
  const saveRule = (account: Account, input: FilterInput, id: string) =>
    Effect.gen(function* () {
      if (input.criteria.query || input.action.star || input.criteria.exceptAttachment === false)
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
          conditions: {
            ...(c.from ? { senderContains: [c.from] } : {}),
            ...(c.to ? { recipientContains: [c.to] } : {}),
            ...(c.subject ? { subjectContains: [c.subject] } : {}),
            ...(c.hasAttachment ? { hasAttachments: true } : {}),
            ...(c.hasWords ? { bodyOrSubjectContains: [c.hasWords] } : {}),
            ...(c.size !== undefined
              ? {
                  withinSizeRange:
                    c.sizeComparison === "smaller"
                      ? { maximumSize: c.size / 1024 }
                      : { minimumSize: c.size / 1024 },
                }
              : {}),
          },
          ...(Object.keys(ruleExceptions(c)).length || original.exceptions
            ? { exceptions: ruleExceptions(c) }
            : {}),
          actions: {
            ...(input.action.stopProcessing !== undefined
              ? { stopProcessingRules: input.action.stopProcessing }
              : {}),
            ...(input.action.important !== undefined
              ? { markImportance: input.action.important ? "high" : "normal" }
              : {}),
            ...(input.action.markRead ? { markAsRead: true } : {}),
            ...(input.action.trash ? { delete: true } : {}),
            ...(input.action.label || archive
              ? { moveToFolder: input.action.label ?? archive?.id }
              : {}),
          },
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
        if (input.criteria.query || input.action.star || input.criteria.exceptAttachment === false)
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
        const raw = yield* write(account.id, "POST", "/me/mailFolders/inbox/messageRules", {
          displayName: input.name,
          sequence: Math.max(0, ...existing.value.map((r) => r.sequence)) + 1,
          isEnabled: true,
          conditions: {
            ...(c.from ? { senderContains: [c.from] } : {}),
            ...(c.to ? { recipientContains: [c.to] } : {}),
            ...(c.subject ? { subjectContains: [c.subject] } : {}),
            ...(c.hasAttachment ? { hasAttachments: true } : {}),
            ...(c.hasWords ? { bodyOrSubjectContains: [c.hasWords] } : {}),
            ...(c.size !== undefined
              ? {
                  withinSizeRange:
                    c.sizeComparison === "smaller"
                      ? { maximumSize: c.size / 1024 }
                      : { minimumSize: c.size / 1024 },
                }
              : {}),
          },
          ...(Object.keys(ruleExceptions(c)).length ? { exceptions: ruleExceptions(c) } : {}),
          actions: {
            ...(input.action.stopProcessing !== undefined
              ? { stopProcessingRules: input.action.stopProcessing }
              : {}),
            ...(input.action.important !== undefined
              ? { markImportance: input.action.important ? "high" : "normal" }
              : {}),
            ...(input.action.markRead ? { markAsRead: true } : {}),
            ...(input.action.trash ? { delete: true } : {}),
            ...(input.action.label || archive
              ? { moveToFolder: input.action.label ?? archive?.id }
              : {}),
          },
        });
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
