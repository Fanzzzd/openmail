import { decodeProviderId as importedDecodeProviderId } from "../../providers/imap/imap-cursor.js";
import type { SendOriginal } from "../../providers/send-original.js";
import { BASE_SCOPES, OPTIONAL_SCOPES } from "../../providers/optional-services.js";
import {
  calendarTimestamp,
  type CalendarEvent,
  type CalendarInvite,
  type InviteResponse,
} from "../../calendar/calendar.js";
import { Effect, Option, Stream } from "effect";

import { attachmentFromRaw } from "../../mime/attachments.js";
import { MailCodec, type MailCodecPort } from "../mail-codec.js";
import { nodeMailCodec } from "./mail-codec.js";
import { buildMime } from "./compose.js";
import type { Address, IncomingMessage } from "../../domain/message.js";
import type { DraftRemote, MailOp, OutgoingMessage } from "../../domain/changes.js";
import type { Label } from "../../domain/account.js";
import {
  FeatureScopeMissing,
  PermanentError,
  SettingsScopeMissing,
  type ProviderFailure,
} from "../../domain/errors.js";
import type { Change, ConnectInput, DraftPush, ProviderAdapter } from "../../providers/adapter.js";
import {
  EMPTY_VACATION,
  type ServerFilter,
  type Vacation,
  type SendAs,
} from "../../domain/organization.js";
import { FOLDER_BATCH_LIMIT, GMAIL_PERMANENT_DELETE_SCOPE } from "../../domain/folder-actions.js";
import { matchesSearch } from "../../search/search-match.js";
import { applyOpToLabels } from "../../store/store.js";

/** Ids handed out by fake servers; unique across servers so tests never mix them up. */
let counter = 0;

/** A provider's server side, in memory. Tests read and change it directly. */
export interface FakeServer {
  supportsPermanentDelete: boolean;
  deleteFolderLabels: Record<
    import("../../domain/folder-actions.js").DeleteFolder,
    readonly string[]
  >;
  grantedScopes: string[];
  contacts: Address[];
  contactGroups: import("../../contacts/contacts.js").ContactGroup[];
  contactPhotos: import("../../contacts/contacts.js").ContactPhoto[];
  calendarEvents: CalendarEvent[];
  createdEvents: CalendarEvent[];
  responses: { invite: CalendarInvite; response: InviteResponse }[];
  featureFailure?: FeatureScopeMissing;
  email: string;
  messages: Map<string, IncomingMessage>;
  /** Every sign-in, as the adapter received it. */
  connects: ConnectInput[];
  labels: Omit<Label, "accountId">[];
  filters: ServerFilter[];
  vacation: Vacation;
  aliases: SendAs[];
  deleted: (readonly string[])[];
  folderPages: (string | null)[];
  pulls: (string | null)[];
  searched: import("../../domain/message.js").ThreadQuery[];
  searchResults?: IncomingMessage[];
  pushed: { providerId: string; op: MailOp }[];
  batches: { providerIds: readonly string[]; op: MailOp }[];
  sent: {
    message: OutgoingMessage;
    original: Option.Option<SendOriginal>;
  }[];
  /** Drafts by draft id. Like Gmail, each save gives the draft a new message id. */
  drafts: Map<string, { messageId: string; push: DraftPush }>;
  /** Raw MIME the adapter hands out by message id; others are built from `messages`. */
  raw: Map<string, Uint8Array>;
  rawFetched: string[];
  /** Every draft save and delete, in order. */
  backfillFetched: string[];
  bodyFetched: string[];
  draftLog: ({ kind: "save"; push: DraftPush } | { kind: "delete"; remote: DraftRemote })[];
  /** The next push, send, pull or draft call fails with this, once. */
  failNext?: ProviderFailure;
  /** Submission uncertainty is a send-only adapter result. */
  sendFailure?: ProviderFailure | import("../../domain/errors.js").SendUncertain;
  /** Raw MIME filed through fileSentCopy, and a failure for the next call. */
  sentCopies: Uint8Array[];
  /** When set, send reports SMTP acceptance of these bytes through the preparation. */
  acceptedRaw?: Uint8Array;
  acceptedMarks?: number;
  /** Runs after SMTP acceptance is reported, while the live send still holds its record. */
  afterAccepted?: Effect.Effect<void>;
  sentCopyFailure?: ProviderFailure;
  /** A test-controlled network stall; local batch commits must not wait for it. */
  beforePush?: Effect.Effect<void, ProviderFailure>;
  settingsFailure?: SettingsScopeMissing;
}

export function fakeServer(email: string, messages: IncomingMessage[] = []): FakeServer {
  return {
    supportsPermanentDelete: true,
    deleteFolderLabels: { trash: ["TRASH"], spam: ["SPAM"] },
    grantedScopes: [
      ...new Set([
        ...BASE_SCOPES.gmail,
        ...BASE_SCOPES.outlook,
        ...Object.values(OPTIONAL_SCOPES.gmail).flat(),
        ...Object.values(OPTIONAL_SCOPES.outlook).flat(),
      ]),
    ],
    email,
    contacts: [],
    contactGroups: [],
    contactPhotos: [],
    calendarEvents: [],
    createdEvents: [],
    responses: [],
    messages: new Map(messages.map((m) => [m.providerId, m])),
    connects: [],
    labels: [],
    filters: [],
    vacation: EMPTY_VACATION,
    aliases: [],
    pulls: [],
    searched: [],
    deleted: [],
    folderPages: [],
    pushed: [],
    batches: [],
    sent: [],
    sentCopies: [],
    drafts: new Map(),
    raw: new Map(),
    rawFetched: [],
    draftLog: [],
    backfillFetched: [],
    bodyFetched: [],
  };
}

/**
 * A provider using the account's label or folder model over a FakeServer. Every pull is a full
 * pull; the cursor counts pulls so tests can see checkpoints land.
 */
export function makeFakeProvider(
  server: FakeServer,
  options: { strictFolders?: boolean; batches?: boolean; codec?: MailCodecPort } = {},
): ProviderAdapter {
  const codec = options.codec ?? nodeMailCodec;
  let pulled = new Set<string>();
  const failOnce = Effect.suspend(() => {
    const failure = server.failNext;
    server.failNext = undefined;
    return failure ? Effect.fail(failure) : Effect.void;
  });
  const settingsReady = Effect.suspend(
    (): Effect.Effect<void, ProviderFailure | SettingsScopeMissing> =>
      server.settingsFailure ? Effect.fail(server.settingsFailure) : failOnce,
  );
  const pushMessage: ProviderAdapter["push"] = (account, providerId, op) =>
    Effect.andThen(
      Effect.suspend(() => server.beforePush ?? Effect.void),
      Effect.andThen(
        Effect.andThen(
          failOnce,
          Effect.suspend(() =>
            ((op.kind === "categories" || op.kind === "classification") &&
              account.provider !== "outlook") ||
            (op.kind === "copy" && account.provider !== "imap")
              ? Effect.fail(
                  new PermanentError({
                    message: "Organization action unavailable for this account",
                  }),
                )
              : options.strictFolders &&
                  account.provider !== "gmail" &&
                  op.kind === "label" &&
                  op.value &&
                  !server.labels.some((label) => label.id === op.labelId)
                ? Effect.fail(new PermanentError({ message: `Unknown folder: ${op.labelId}` }))
                : Effect.void,
          ),
        ),
        Effect.sync(() => {
          server.pushed.push({ providerId, op });
          const m = server.messages.get(providerId);
          if (!m) return;
          if (op.kind === "copy") {
            for (const folder of new Set(op.labelIds)) {
              if (m.labels.includes(folder)) continue;
              const id = `copy:${++counter}`;
              server.messages.set(id, {
                ...m,
                providerId: id,
                threadId: id,
                labels: [
                  folder,
                  ...(m.isUnread ? ["UNREAD"] : []),
                  ...(m.isStarred ? ["STARRED"] : []),
                ],
              });
            }
            return;
          }
          const labels = applyOpToLabels([...m.labels], op, account.provider);
          server.messages.set(providerId, {
            ...m,
            labels,
            isUnread: labels.includes("UNREAD"),
            isStarred: labels.includes("STARRED"),
          });
        }),
      ),
    );
  return {
    folderStatus: (account, scope) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          const messages = [...server.messages.values()].filter((message) =>
            account.provider === "imap"
              ? Option.getOrUndefined(importedDecodeProviderId(message.providerId))?.path === scope
              : message.labels.includes(scope),
          );
          return {
            total: messages.length,
            unread: messages.filter((message) => message.isUnread).length,
            threads:
              account.provider === "gmail"
                ? new Set(messages.map((message) => message.threadId)).size
                : null,
            uidNext: account.provider === "imap" ? messages.length + 1 : null,
            uidValidity: account.provider === "imap" ? "1" : null,
          };
        }),
      ),
    listFolderMessages: (_account, folder, cursor, listOptions) =>
      Effect.andThen(
        Effect.andThen(
          failOnce,
          Effect.suspend(() =>
            options.strictFolders &&
            folder.label &&
            ![
              "inbox",
              "archive",
              "deleteditems",
              "junkemail",
              "INBOX",
              "ARCHIVE",
              "TRASH",
              "SPAM",
            ].includes(folder.label) &&
            !server.labels.some((label) => label.id === folder.label)
              ? Effect.fail(new PermanentError({ message: "Destination folder is gone" }))
              : Effect.void,
          ),
        ),
        Effect.sync(() => {
          server.folderPages.push(cursor);
          const ids = [...server.messages.values()]
            .filter(
              (m) =>
                (!listOptions?.unreadOnly || m.isUnread) &&
                (!folder.label || m.labels.includes(folder.label)) &&
                (folder.mailbox !== "all" ||
                  !m.labels.some((label) => label === "TRASH" || label === "SPAM")) &&
                (listOptions?.includeChildren &&
                !folder.label &&
                (folder.mailbox === "trash" || folder.mailbox === "spam")
                  ? m.labels.some((label) =>
                      server.deleteFolderLabels[
                        folder.mailbox === "trash" ? "trash" : "spam"
                      ].includes(label),
                    )
                  : matchesSearch(
                      m,
                      { mailbox: folder.mailbox, searchScope: "folder" },
                      server.labels,
                    )),
            )
            .toSorted((a, b) =>
              listOptions?.newestFirst
                ? b.date - a.date || b.providerId.localeCompare(a.providerId)
                : a.providerId.localeCompare(b.providerId),
            )
            .map((m) => m.providerId);
          const remaining = listOptions?.newestFirst
            ? ids.slice(cursor === null ? 0 : ids.indexOf(cursor) + 1)
            : ids.filter((id) => cursor === null || id > cursor);
          const page = remaining.slice(0, FOLDER_BATCH_LIMIT);
          return { ids: page, next: remaining.length > page.length ? (page.at(-1) ?? null) : null };
        }),
      ),
    checkPermanentDelete: (account, folder) =>
      account.provider === "imap" && !server.supportsPermanentDelete
        ? Effect.fail(
            new PermanentError({
              message:
                "This IMAP server cannot safely expunge selected messages (UIDPLUS required).",
            }),
          )
        : Effect.succeed(server.deleteFolderLabels[folder]),
    permanentlyDelete: (_account, ids, folder) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          const verified = ids.filter((id) =>
            server.messages
              .get(id)
              ?.labels.some((label) => server.deleteFolderLabels[folder].includes(label)),
          );
          if (verified.length) server.deleted.push(verified);
          for (const id of verified) server.messages.delete(id);
          return { kind: "complete", ids: verified } as const;
        }),
      ),
    markReadBatch: (account, ids) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.batches.push({ providerIds: ids, op: { kind: "read", value: true } });
          for (const id of ids) {
            const incoming = server.messages.get(id);
            if (incoming)
              server.messages.set(id, {
                ...incoming,
                isUnread: false,
                labels: applyOpToLabels(
                  incoming.labels,
                  { kind: "read", value: true },
                  account.provider,
                ),
              });
          }
        }),
      ),
    backfill: (_account, state, select) =>
      Effect.gen(function* () {
        yield* failOnce;
        const all = [...server.messages.values()]
          .filter((m) => m.date < state.before)
          .toSorted((a, b) => b.date - a.date || (a.providerId < b.providerId ? 1 : -1));
        const start = state.cursor === null ? 0 : Number(state.cursor);
        const page = all.slice(start, start + 50);
        const ids = page.map((m) => m.providerId);
        const selected = new Set(select ? yield* select(ids) : ids);
        const messages = page.filter((m) => selected.has(m.providerId));
        server.backfillFetched.push(...messages.map((m) => m.providerId));
        return {
          messages,
          scanned: page.length,
          cursor: start + 50 < all.length ? String(start + 50) : null,
        };
      }),
    fetchMessage: (_account, id) =>
      Effect.andThen(
        failOnce,
        Effect.suspend(() => {
          server.bodyFetched.push(id);
          const message = server.messages.get(id);
          return message
            ? Effect.succeed(message)
            : Effect.fail(new PermanentError({ message: `Message ${id} is gone` }));
        }),
      ),
    ...(server.contactGroups.length || server.contactPhotos.length
      ? {
          contactSnapshot: () =>
            Effect.suspend(
              (): NonNullable<ReturnType<NonNullable<ProviderAdapter["contactSnapshot"]>>> =>
                server.featureFailure
                  ? Effect.fail(server.featureFailure)
                  : Effect.andThen(
                      failOnce,
                      Effect.sync(() => ({
                        contacts: server.contacts,
                        groups: server.contactGroups,
                        photos: server.contactPhotos,
                      })),
                    ),
            ),
        }
      : {}),
    calendarEvents: (_account, event) =>
      server.featureFailure
        ? Effect.fail(server.featureFailure)
        : Effect.succeed(
            // The fake server keeps its calendar in UTC.
            server.calendarEvents.filter(
              (other) =>
                calendarTimestamp(other.end, "UTC") > calendarTimestamp(event.start, "UTC") &&
                calendarTimestamp(other.start, "UTC") < calendarTimestamp(event.end, "UTC"),
            ),
          ),
    createCalendarEvent: (_account, event) =>
      server.featureFailure
        ? Effect.fail(server.featureFailure)
        : Effect.sync(() => {
            server.createdEvents.push(event);
          }),
    contacts: () =>
      Effect.suspend((): ReturnType<ProviderAdapter["contacts"]> =>
        server.featureFailure
          ? Effect.fail(server.featureFailure)
          : Effect.andThen(
              failOnce,
              Effect.sync(() => server.contacts),
            ),
      ),
    respondInvite: (_account, _id, invite, response) =>
      Effect.suspend((): ReturnType<ProviderAdapter["respondInvite"]> =>
        server.featureFailure
          ? Effect.fail(server.featureFailure)
          : Effect.andThen(
              failOnce,
              Effect.sync(() => {
                server.responses.push({ invite, response });
              }),
            ),
      ),
    search: (account, query) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.searched.push(query);
          const matches =
            server.searchResults ??
            [...server.messages.values()].filter((m) =>
              matchesSearch(m, query, server.labels, account.provider),
            );
          return {
            messages: matches.slice(0, query.limit ?? 200),
            truncated: matches.length > (query.limit ?? 200),
          };
        }),
      ),
    changeLabel: (_account, change) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          if (change.kind === "create")
            server.labels.push({
              id: `label${++counter}`,
              name: change.parentId
                ? `${server.labels.find((l) => l.id === change.parentId)?.name}/${change.name}`
                : change.name,
              color: null,
            });
          else if (change.kind === "delete")
            server.labels = server.labels.filter((l) => l.id !== change.id);
          else
            server.labels = server.labels.map((l) =>
              l.id !== change.id
                ? l
                : change.kind === "rename"
                  ? { ...l, name: change.name }
                  : change.kind === "visibility"
                    ? {
                        ...l,
                        labelListVisibility: change.labelListVisibility,
                        messageListVisibility: change.messageListVisibility,
                      }
                    : change.kind === "parent"
                      ? {
                          ...l,
                          name: `${change.parentId ? `${server.labels.find((p) => p.id === change.parentId)?.name}/` : ""}${l.name.split("/").at(-1)}`,
                        }
                      : { ...l, color: change.color },
            );
          return server.labels;
        }),
      ),
    filters: () =>
      Effect.andThen(
        settingsReady,
        Effect.sync(() => server.filters),
      ),
    createFilter: (_account, input) =>
      Effect.andThen(
        settingsReady,
        Effect.sync(() => {
          const filter = { ...input, id: `filter${++counter}` };
          server.filters.push(filter);
          return filter;
        }),
      ),
    updateFilter: (account, id, input) =>
      Effect.andThen(
        settingsReady,
        Effect.sync(() => {
          server.filters = server.filters.filter((f) => f.id !== id);
          const filter = { ...input, id: account.provider === "gmail" ? `filter${++counter}` : id };
          server.filters.push(filter);
          return filter;
        }),
      ),
    deleteFilter: (_account, id) =>
      Effect.andThen(
        settingsReady,
        Effect.sync(() => {
          server.filters = server.filters.filter((f) => f.id !== id);
        }),
      ),
    vacation: () =>
      Effect.andThen(
        settingsReady,
        Effect.sync(() => server.vacation),
      ),
    setVacation: (_account, input) =>
      Effect.andThen(
        settingsReady,
        Effect.sync(() => {
          server.vacation = input;
        }),
      ),
    sendAs: () =>
      Effect.andThen(
        settingsReady,
        Effect.sync(() => server.aliases),
      ),
    connect: (input) =>
      Effect.sync(() => {
        server.connects.push(input);
        if (input.provider === "gmail" && input.feature === "permanentDelete")
          server.grantedScopes = [
            ...new Set([...server.grantedScopes, GMAIL_PERMANENT_DELETE_SCOPE]),
          ];
        return { email: server.email, secret: "fake-token", scopes: server.grantedScopes };
      }),
    pull: (_account, cursor, scope) =>
      Stream.unwrap(
        Effect.map(
          Effect.andThen(
            Effect.sync(() => server.pulls.push(Option.getOrNull(cursor))),
            failOnce,
          ),
          () => {
            const next = String(Number(Option.getOrElse(cursor, () => "0")) + 1);
            // Messages gone since the last pull are reported deleted, as Gmail history does.
            const gone = scope ? [] : [...pulled].filter((id) => !server.messages.has(id));
            if (!scope) pulled = new Set(server.messages.keys());
            const changes: Change[] = [
              ...(!scope ? [{ _tag: "Labels", labels: server.labels } as const] : []),
              ...[...server.messages.values()]
                .filter((m) => !scope || m.labels.includes("INBOX"))
                .map((message): Change => ({
                  _tag: "Upsert",
                  message,
                })),
              ...gone.map((providerId): Change => ({ _tag: "Delete", providerId })),
              { _tag: "Progress", fetched: server.messages.size, total: server.messages.size },
              { _tag: "Cursor", cursor: next },
            ];
            return Stream.fromIterable(changes);
          },
        ),
      ),
    push: pushMessage,
    ...(options.batches
      ? {
          pushBatch: (
            account: import("../../domain/account.js").Account,
            providerIds: readonly string[],
            op: MailOp,
          ) =>
            Effect.gen(function* () {
              server.batches.push({ providerIds, op });
              yield* Effect.forEach(providerIds, (id) => pushMessage(account, id, op), {
                discard: true,
              });
            }),
        }
      : {}),
    fileSentCopy: (_account, raw) =>
      Effect.suspend(() => {
        const failure = server.sentCopyFailure;
        server.sentCopyFailure = undefined;
        if (failure) return Effect.fail(failure);
        server.sentCopies.push(raw);
        return Effect.void;
      }),
    send: (_account, message, original, preparation) =>
      Effect.andThen(
        Effect.suspend(() => {
          const failure = server.sendFailure;
          server.sendFailure = undefined;
          return failure ? Effect.fail(failure) : failOnce;
        }),
        Effect.gen(function* () {
          server.sent.push({ message, original });
          if (server.acceptedRaw && preparation?.accepted) {
            yield* preparation.accepted(server.acceptedRaw);
            server.acceptedMarks = (server.acceptedMarks ?? 0) + 1;
            if (server.afterAccepted) yield* server.afterAccepted;
          }
        }),
      ),
    getDraftOrganization: (account, id) =>
      Effect.sync(() => {
        const message = server.messages.get(id);
        return {
          labels: (message?.labels ?? []).filter((label) =>
            account.provider === "gmail"
              ? label.startsWith("Label_")
              : !["DRAFT", "STARRED", "UNREAD"].includes(label),
          ),
          starred: message?.isStarred ?? false,
        };
      }),
    saveDraft: (_account, push) =>
      Effect.andThen(
        failOnce,
        Effect.sync((): DraftRemote => {
          server.draftLog.push({ kind: "save", push });
          const known = push.remote?.draftId ?? findDraft(server, push.remote?.messageId);
          const draftId = known && server.drafts.has(known) ? known : `d${++counter}`;
          const previous = server.drafts.get(draftId);
          const previousMessage = server.messages.get(
            previous?.messageId ?? push.remote?.messageId ?? "",
          );
          if (previous) server.messages.delete(previous.messageId);
          else if (push.remote?.messageId) server.messages.delete(push.remote.messageId);
          const messageId = `dm${++counter}`;
          server.drafts.set(draftId, { messageId, push });
          const m = push.message;
          server.messages.set(messageId, {
            providerId: messageId,
            threadId: Option.match(push.original, {
              onNone: () => `t-${messageId}`,
              onSome: (o) => o.threadId,
            }),
            subject: m.subject,
            from: { name: "", address: server.email },
            to: m.to,
            cc: m.cc,
            date: 2_000 + counter,
            snippet: m.text.slice(0, 50),
            bodyText: m.text,
            bodyHtml: m.html ?? "",
            labels: push.message.draftOrganization
              ? ["DRAFT", ...push.message.draftOrganization.labels]
              : (previousMessage?.labels ?? ["DRAFT"]),
            attachments: m.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              size: (a.content.length * 3) / 4,
            })),
            isUnread: false,
            isStarred:
              push.message.draftOrganization?.starred ?? previousMessage?.isStarred ?? false,
          });
          return { draftId, messageId };
        }),
      ),
    deleteDraft: (_account, remote) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.draftLog.push({ kind: "delete", remote });
          const id = remote.draftId ?? findDraft(server, remote.messageId);
          const draft = id === undefined ? undefined : server.drafts.get(id);
          if (!id || !draft) return;
          server.drafts.delete(id);
          server.messages.delete(draft.messageId);
        }),
      ),
    fetchAttachment: (_account, providerId, ref) =>
      Effect.andThen(
        failOnce,
        Effect.suspend(() => {
          const raw = server.raw.get(providerId);
          if (!raw) return Effect.fail(new PermanentError({ message: `No source ${providerId}` }));
          return attachmentFromRaw(raw, ref).pipe(
            Effect.provideService(MailCodec, codec),
            Effect.flatMap((bytes) =>
              bytes
                ? Effect.succeed(bytes)
                : Effect.fail(new PermanentError({ message: `No attachment ${ref.filename}` })),
            ),
          );
        }),
      ),
    fetchRaw: (account, providerId) =>
      Effect.andThen(
        failOnce,
        Effect.suspend(() => {
          server.rawFetched.push(providerId);
          const raw = server.raw.get(providerId);
          if (raw) return Effect.succeed(raw);
          const m = server.messages.get(providerId);
          if (!m) return Effect.fail(new PermanentError({ message: `No message ${providerId}` }));
          const draft = [...server.drafts.values()].find((entry) => entry.messageId === providerId);
          if (draft) {
            return buildMime(
              { name: "", address: account.email },
              draft.push.message,
              {},
              { draft: true },
            ).pipe(Effect.map((bytes) => new Uint8Array(bytes)));
          }
          return buildMime(m.from.address ? m.from : { name: "", address: account.email }, {
            to: m.to,
            cc: m.cc,
            bcc: [],
            subject: m.subject,
            text: m.bodyText,
            ...(m.bodyHtml ? { html: m.bodyHtml } : {}),
            attachments: [],
          }).pipe(Effect.map((b) => new Uint8Array(b)));
        }),
      ),
  };
}

function findDraft(server: FakeServer, messageId: string | null | undefined): string | undefined {
  if (!messageId) return undefined;
  for (const [id, d] of server.drafts) if (d.messageId === messageId) return id;
  return undefined;
}
