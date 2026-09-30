import { Effect, Schema } from "effect";
import type { Account } from "./domain.js";
import { AuthError, PermanentError, ProviderError, SettingsScopeMissing } from "./errors.js";
import { graphTimestamp } from "./graph-time.js";
import { escapeHtml } from "./print.js";
import { htmlToText } from "./mime.js";
import {
  EMPTY_FILTER,
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
const GraphRule = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  conditions: Schema.optionalKey(
    Schema.Struct({
      senderContains: Strings,
      recipientContains: Strings,
      subjectContains: Strings,
      bodyContains: Strings,
      hasAttachments: Schema.optionalKey(Schema.Boolean),
      fromAddresses: Recipients,
      sentToAddresses: Recipients,
    }),
  ),
  actions: Schema.optionalKey(
    Schema.Struct({
      markAsRead: Schema.optionalKey(Schema.Boolean),
      delete: Schema.optionalKey(Schema.Boolean),
      moveToFolder: Schema.optionalKey(Schema.String),
    }),
  ),
});
const DateTime = Schema.Struct({ dateTime: Schema.String, timeZone: Schema.String });
const Replies = Schema.Struct({
  status: Schema.String,
  scheduledStartDateTime: Schema.optionalKey(DateTime),
  scheduledEndDateTime: Schema.optionalKey(DateTime),
  externalAudience: Schema.optionalKey(Schema.String),
  internalReplyMessage: Schema.optionalKey(Schema.String),
  externalReplyMessage: Schema.optionalKey(Schema.String),
});
function fromRule(r: typeof GraphRule.Type): ServerFilter {
  const c = r.conditions;
  return {
    id: r.id,
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
      query: c?.bodyContains?.join(" ") ?? "",
      hasAttachment: c?.hasAttachments ?? false,
    },
    action: {
      ...EMPTY_FILTER.action,
      markRead: r.actions?.markAsRead ?? false,
      trash: r.actions?.delete ?? false,
      label: r.actions?.moveToFolder ?? null,
    },
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
  return {
    filters: (account: Account) =>
      wrap(
        account,
        get(
          account.id,
          Schema.Struct({ value: Schema.Array(GraphRule) }),
          "/me/mailFolders/inbox/messageRules",
        ).pipe(Effect.map((r) => r.value.map(fromRule))),
      ),
    createFilter: (account: Account, input: FilterInput) =>
      Effect.gen(function* () {
        // Graph rules have no Gmail query parser or flag action. Reject rather than create a broader rule.
        if (input.criteria.query || input.action.star)
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
          },
          actions: {
            ...(input.action.markRead ? { markAsRead: true } : {}),
            ...(input.action.trash ? { delete: true } : {}),
            ...(input.action.label || archive
              ? { moveToFolder: input.action.label ?? archive?.id }
              : {}),
          },
        });
        return fromRule(yield* Schema.decodeUnknownEffect(GraphRule)(raw).pipe(Effect.orDie));
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
                body: htmlToText(v.externalReplyMessage ?? v.internalReplyMessage ?? ""),
                contactsOnly: v.externalAudience === "contactsOnly",
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
        write(account.id, "PATCH", "/me/mailboxSettings", {
          automaticRepliesSetting: {
            status: !v.enabled
              ? "disabled"
              : v.start !== null && v.end !== null
                ? "scheduled"
                : "alwaysEnabled",
            externalAudience: v.contactsOnly ? "contactsOnly" : "all",
            internalReplyMessage: `<p>${escapeHtml(v.body).replaceAll("\n", "<br>")}</p>`,
            externalReplyMessage: `<p>${escapeHtml(v.body).replaceAll("\n", "<br>")}</p>`,
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
        }).pipe(Effect.asVoid),
      ),
    sendAs: (_account: Account) => Effect.succeed([]),
  };
}
