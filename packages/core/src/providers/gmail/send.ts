import { Clock, Effect, Option } from "effect";
import { newMessageId } from "../../mime/message-id.js";
import { PlatformCrypto, sha256Hex } from "../../platform/crypto.js";
import { DRAFT_WRITE_HEADER } from "../../platform/mail-codec.js";
import { gmailPages } from "../provider-pages.js";
import { uncertainWrite } from "../provider-retry.js";
import { deliverOrConfirm } from "../provider-send.js";
import { cachedThreading, type SendOriginal } from "../send-original.js";

import { GMAIL_MIME_LIMIT } from "../../mime/attachment-policy.js";
import { type Threading } from "../../compose/compose.js";
import type { Account } from "../../domain/account.js";
import type { DraftRemote, OutgoingMessage } from "../../domain/changes.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../../domain/errors.js";
import type { DraftPush, DraftSaveResult } from "../adapter.js";

import {
  Metadata,
  MessageList,
  writeFailure,
  DraftList,
  GmailDraft,
  is404,
  decode,
} from "./api.js";
import type { GmailClient } from "./client.js";

/** Sending, and drafts saved to and deleted from Gmail. */
export const makeGmailSend = (client: GmailClient) => {
  const { crypto, buildMime, get, post, put, del } = client;
  const fetchThreading = (accountId: string, providerId: string) =>
    get(
      accountId,
      Metadata,
      // Repeated metadataHeaders params; urlParams would need an array form.
      `/messages/${encodeURIComponent(providerId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
    ).pipe(
      Effect.map(({ payload }): Threading => {
        const header = (name: string) =>
          payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
        return { messageId: header("Message-ID"), references: header("References") };
      }),
    );
  /**
   * Threading for a reply or forward, and the Gmail thread to file it in. When Gmail no
   * longer has the original (purged from Trash, deleted elsewhere) the message goes out as a
   * new Gmail thread that still carries the cached In-Reply-To and References.
   */
  const threadingFor = (accountId: string, message: OutgoingMessage, original: SendOriginal) =>
    fetchThreading(accountId, original.providerId).pipe(
      Effect.map((threading) => ({
        threading,
        // Forwards start a new thread; replies stay in the original one.
        threadId: message.mode === "forward" ? undefined : original.threadId,
      })),
      Effect.catchIf(is404, () =>
        Effect.succeed({ threading: cachedThreading(original), threadId: undefined }),
      ),
    );

  const send = Effect.fn("Gmail.send")(
    function* (account: Account, message: OutgoingMessage, original: Option.Option<SendOriginal>) {
      const { threading, threadId }: { threading: Threading; threadId: string | undefined } =
        Option.isSome(original)
          ? yield* threadingFor(account.id, message, original.value)
          : { threading: {}, threadId: undefined };
      const sender = message.from ?? { name: "", address: account.email };
      const messageId = yield* newMessageId(sender.address).pipe(
        Effect.provideService(PlatformCrypto, crypto),
      );
      const traceId = messageId.slice(1, messageId.indexOf("@"));
      const started = yield* Clock.currentTimeMillis;
      const raw = yield* buildMime(sender, message, threading, { messageId });
      if (raw.byteLength > GMAIL_MIME_LIMIT)
        yield* new PermanentError({
          message:
            "Gmail MIME message exceeds 25 MB. Remove attachments or shorten the body before sending.",
        });
      yield* deliverOrConfirm(
        post(account.id, "/messages/send", {
          raw: raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
          ...(threadId ? { threadId } : {}),
        }),
        Effect.gen(function* () {
          const found = yield* get(account.id, MessageList, "/messages", {
            q: `in:sent rfc822msgid:${messageId}`,
            maxResults: "1",
          });
          if (found.messages?.length) return true;
          // Inspect a bounded Sent window: Gmail does not promise ID preservation or partial-ID search.
          const recent = yield* get(account.id, MessageList, "/messages", {
            q: `in:sent after:${Math.floor(started / 1000) - 60} before:${Math.floor(started / 1000) + 120}`,
            maxResults: "20",
          });
          for (const candidate of recent.messages ?? []) {
            const metadata = yield* get(
              account.id,
              Metadata,
              `/messages/${encodeURIComponent(candidate.id)}?format=metadata&metadataHeaders=Message-ID`,
            );
            if (
              metadata.payload.headers?.some(
                (header) =>
                  header.name.toLowerCase() === "message-id" &&
                  /^<([^<>@\s]+)@[^<>\s]+>$/.exec(header.value.trim())?.[1] === traceId,
              )
            )
              return true;
          }
          return false;
        }),
        (error) => error._tag === "ApiError" && uncertainWrite(error),
      );
    },
    (effect, account) =>
      Effect.mapError(effect, (error) =>
        error._tag === "SendUncertain" ? error : writeFailure(account.id)(error),
      ),
  );

  /**
   * The draft id behind a draft message. Gmail keeps the draft id stable but
   * gives the message a new id on every save; a draft that came in through a
   * pull is only known by its message id.
   */
  const findDraftId = Effect.fnUntraced(function* (accountId: string, messageId: string) {
    for (const loadPage of gmailPages((pageToken) =>
      get(accountId, DraftList, "/drafts", {
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      }),
    )) {
      const page = yield* loadPage;
      const found = page.drafts?.find((d) => d.message.id === messageId);
      if (found) return Option.some(found.id);
    }
    return Option.none<string>();
  });

  const draftIdOf = (accountId: string, remote: DraftRemote | null) =>
    remote?.draftId
      ? Effect.succeed(Option.some(remote.draftId))
      : remote?.messageId
        ? findDraftId(accountId, remote.messageId)
        : Effect.succeed(Option.none<string>());

  const saveDraft = Effect.fn("Gmail.saveDraft")(
    function* (account: Account, draft: DraftPush) {
      const { message, original } = draft;
      const { threading, threadId }: { threading: Threading; threadId: string | undefined } =
        Option.isSome(original)
          ? yield* threadingFor(account.id, message, original.value)
          : { threading: {}, threadId: undefined };
      const nonce = sha256Hex(JSON.stringify([message, threading, threadId ?? null]));
      const makeBody = (messageId?: string, writeNonce?: string) =>
        Effect.gen(function* () {
          const raw = yield* buildMime(
            message.from ?? { name: "", address: account.email },
            message,
            threading,
            {
              draft: true,
              ...(messageId ? { messageId } : {}),
              ...(writeNonce ? { writeNonce } : {}),
            },
          );
          if (raw.byteLength > GMAIL_MIME_LIMIT)
            return yield* new PermanentError({
              message:
                "Gmail MIME message exceeds 25 MB. Remove attachments or shorten the body before sending.",
            });
          return {
            message: {
              raw: raw
                .toString("base64")
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/, ""),
              ...(threadId ? { threadId } : {}),
            },
          };
        });
      let saveError: ProviderFailure | undefined;
      const create = Effect.gen(function* () {
        const state = yield* draft.creation.begin();
        const lookup = Effect.gen(function* () {
          const found = yield* get(account.id, MessageList, "/messages", {
            q: `in:drafts rfc822msgid:${state.messageId}`,
            maxResults: "2",
          });
          const foundMessage = found.messages?.[0];
          if (!foundMessage) return Option.none<typeof GmailDraft.Type>();
          const id = yield* findDraftId(account.id, foundMessage.id);
          return Option.map(id, (draftId) => ({ id: draftId, message: { id: foundMessage.id } }));
        });
        const createdBody = yield* makeBody(state.messageId);
        if (state.attempted) {
          const found = yield* lookup;
          if (Option.isSome(found)) {
            yield* draft.creation.remember({
              draftId: found.value.id,
              messageId: found.value.message.id,
            });
            return yield* put(
              account.id,
              `/drafts/${encodeURIComponent(found.value.id)}`,
              createdBody,
            ).pipe(
              Effect.flatMap(decode(GmailDraft)),
              Effect.catch((error) => {
                saveError = writeFailure(account.id)(error);
                return Effect.succeed(found.value);
              }),
            );
          }
          if (!(yield* draft.creation.missing()))
            return yield* new ProviderError({
              message:
                "Draft creation is uncertain. Waiting for the provider copy before creating another draft.",
            });
        }
        yield* draft.creation.attempted(state.messageId);
        return yield* post(account.id, "/drafts", createdBody).pipe(
          Effect.flatMap(decode(GmailDraft)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (error._tag === "ApiError" && uncertainWrite(error)) {
                const found = yield* lookup;
                if (Option.isSome(found)) return found.value;
              } else if (error._tag === "ApiError")
                yield* draft.creation.attempted(state.messageId, false);
              return yield* Effect.fail(error);
            }),
          ),
        );
      }).pipe(
        Effect.tap((saved) =>
          draft.creation.remember({ draftId: saved.id, messageId: saved.message.id }),
        ),
      );
      const existing = yield* draftIdOf(account.id, draft.remote);
      const current = Option.isSome(existing)
        ? yield* get(account.id, GmailDraft, `/drafts/${encodeURIComponent(existing.value)}`).pipe(
            Effect.map(Option.some),
            Effect.catchIf(is404, () => Effect.succeed(Option.none())),
          )
        : Option.none();
      let conflict =
        Option.isSome(current) &&
        !!draft.remote?.messageId &&
        current.value.message.id !== draft.remote.messageId;
      // A PUT whose response was lost also gave the draft a new message id. The live
      // message carrying our write fingerprint is our own edit, so update it in place.
      if (conflict && Option.isSome(current)) {
        const written = yield* get(
          account.id,
          Metadata,
          `/messages/${encodeURIComponent(current.value.message.id)}?format=metadata&metadataHeaders=${DRAFT_WRITE_HEADER}`,
        ).pipe(
          Effect.map(({ payload }) =>
            payload.headers
              ?.find((h) => h.name.toLowerCase() === DRAFT_WRITE_HEADER.toLowerCase())
              ?.value.replace(/\s+/g, ""),
          ),
          Effect.orElseSucceed(() => null),
        );
        if (written && (written === nonce || written === draft.remote?.writeNonce))
          conflict = false;
      }
      const saved = yield* Option.isSome(existing) && !conflict
        ? // Deleted in another client meanwhile: the person is still writing it.
          (draft.writing ? draft.writing(nonce) : Effect.void).pipe(
            Effect.andThen(makeBody(undefined, nonce)),
            Effect.flatMap((body) =>
              put(account.id, `/drafts/${encodeURIComponent(existing.value)}`, body),
            ),
            Effect.flatMap(decode(GmailDraft)),
            Effect.catchIf(is404, () => create),
          )
        : create;
      return {
        draftId: saved.id,
        messageId: saved.message.id,
        ...(conflict ? { conflict: true } : {}),
        ...(saveError ? { saveError } : {}),
      } satisfies DraftSaveResult;
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const deleteDraft = Effect.fn("Gmail.deleteDraft")(
    function* (account: Account, remote: DraftRemote) {
      const remove = (id: string) =>
        del(account.id, `/drafts/${encodeURIComponent(id)}`).pipe(
          Effect.catchIf(is404, () => Effect.void),
        );
      const id = yield* draftIdOf(account.id, remote);
      if (Option.isSome(id)) {
        yield* remove(id.value);
        return;
      }
      if (!remote.rfcMessageId) return;
      for (const loadPage of gmailPages((pageToken) =>
        get(account.id, MessageList, "/messages", {
          q: `in:drafts rfc822msgid:${remote.rfcMessageId}`,
          maxResults: "100",
          ...(pageToken ? { pageToken } : {}),
        }),
      )) {
        const page = yield* loadPage;
        for (const message of page.messages ?? []) {
          const draftId = yield* findDraftId(account.id, message.id);
          if (Option.isSome(draftId)) yield* remove(draftId.value);
        }
      }
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  return { send, saveDraft, deleteDraft };
};
