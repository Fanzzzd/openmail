import type { CalendarInvite, InviteResponse } from "./calendar.js";
import { Effect, Option, Stream } from "effect";

import { attachmentFromRaw } from "./attachments.js";
import { buildMime } from "./compose.js";
import type { Address, DraftRemote, IncomingMessage, MailOp, OutgoingMessage } from "./domain.js";
import {
  FeatureScopeMissing,
  PermanentError,
  SettingsScopeMissing,
  type ProviderFailure,
} from "./errors.js";
import type { Change, ConnectInput, DraftPush, ProviderAdapter } from "./services.js";
import { EMPTY_VACATION, type ServerFilter, type Vacation, type SendAs } from "./organization.js";
import { matchesSearch } from "./search.js";
import { applyOpToLabels } from "./store.js";

/** Ids handed out by fake servers; unique across servers so tests never mix them up. */
let counter = 0;

/** A provider's server side, in memory. Tests read and change it directly. */
export interface FakeServer {
  contacts: Address[];
  responses: { invite: CalendarInvite; response: InviteResponse }[];
  featureFailure?: FeatureScopeMissing;
  email: string;
  messages: Map<string, IncomingMessage>;
  /** Every sign-in, as the adapter received it. */
  connects: ConnectInput[];
  labels: { id: string; name: string; color: string | null }[];
  filters: ServerFilter[];
  vacation: Vacation;
  aliases: SendAs[];
  searched: import("./domain.js").ThreadQuery[];
  searchResults?: IncomingMessage[];
  pushed: { providerId: string; op: MailOp }[];
  sent: {
    message: OutgoingMessage;
    original: Option.Option<{ providerId: string; threadId: string }>;
  }[];
  /** Drafts by draft id. Like Gmail, each save gives the draft a new message id. */
  drafts: Map<string, { messageId: string; push: DraftPush }>;
  /** Raw MIME the adapter hands out by message id; others are built from `messages`. */
  raw: Map<string, Uint8Array>;
  /** Every draft save and delete, in order. */
  draftLog: ({ kind: "save"; push: DraftPush } | { kind: "delete"; remote: DraftRemote })[];
  /** The next push, send, pull or draft call fails with this, once. */
  failNext?: ProviderFailure;
  settingsFailure?: SettingsScopeMissing;
}

export function fakeServer(email: string, messages: IncomingMessage[] = []): FakeServer {
  return {
    email,
    contacts: [],
    responses: [],
    messages: new Map(messages.map((m) => [m.providerId, m])),
    connects: [],
    labels: [],
    filters: [],
    vacation: EMPTY_VACATION,
    aliases: [],
    searched: [],
    pushed: [],
    sent: [],
    drafts: new Map(),
    raw: new Map(),
    draftLog: [],
  };
}

/**
 * A provider with Gmail's label model over a FakeServer. Every pull is a full
 * pull; the cursor counts pulls so tests can see checkpoints land.
 */
export function makeFakeProvider(server: FakeServer): ProviderAdapter {
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
  return {
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
    search: (_account, query) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.searched.push(query);
          const matches =
            server.searchResults ??
            [...server.messages.values()].filter((m) => matchesSearch(m, query, server.labels));
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
        return { email: server.email, secret: "fake-token" };
      }),
    pull: (_account, cursor) =>
      Stream.unwrap(
        Effect.map(failOnce, () => {
          const next = String(Number(Option.getOrElse(cursor, () => "0")) + 1);
          // Messages gone since the last pull are reported deleted, as Gmail history does.
          const gone = [...pulled].filter((id) => !server.messages.has(id));
          pulled = new Set(server.messages.keys());
          const changes: Change[] = [
            { _tag: "Labels", labels: server.labels },
            ...[...server.messages.values()].map((message): Change => ({
              _tag: "Upsert",
              message,
            })),
            ...gone.map((providerId): Change => ({ _tag: "Delete", providerId })),
            { _tag: "Progress", fetched: server.messages.size, total: server.messages.size },
            { _tag: "Cursor", cursor: next },
          ];
          return Stream.fromIterable(changes);
        }),
      ),
    push: (_account, providerId, op) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.pushed.push({ providerId, op });
          const m = server.messages.get(providerId);
          if (!m) return;
          const labels = applyOpToLabels([...m.labels], op, "gmail");
          server.messages.set(providerId, {
            ...m,
            labels,
            isUnread: labels.includes("UNREAD"),
            isStarred: labels.includes("STARRED"),
          });
        }),
      ),
    send: (_account, message, original) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.sent.push({ message, original });
        }),
      ),
    saveDraft: (_account, push) =>
      Effect.andThen(
        failOnce,
        Effect.sync((): DraftRemote => {
          server.draftLog.push({ kind: "save", push });
          const known = push.remote?.draftId ?? findDraft(server, push.remote?.messageId);
          const draftId = known && server.drafts.has(known) ? known : `d${++counter}`;
          const previous = server.drafts.get(draftId);
          if (previous) server.messages.delete(previous.messageId);
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
            labels: ["DRAFT"],
            attachments: m.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              size: (a.content.length * 3) / 4,
            })),
            isUnread: false,
            isStarred: false,
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
          const raw = server.raw.get(providerId);
          if (raw) return Effect.succeed(raw);
          const m = server.messages.get(providerId);
          if (!m) return Effect.fail(new PermanentError({ message: `No message ${providerId}` }));
          return buildMime(m.from.address ? m.from : { name: "", address: account.email }, {
            to: m.to,
            cc: m.cc,
            bcc: [],
            subject: m.subject,
            text: m.bodyText,
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
