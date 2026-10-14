import type { OutlookClient } from "./client.js";
import { Effect, Option, Schema } from "effect";
import { makeOutlookDraftState } from "./draft-state.js";
import { buildMime as unboundBuildMime } from "../../compose/compose.js";
import { MailCodec } from "../../platform/mail-codec.js";
import type { Account } from "../../domain/account.js";
import type { OutgoingMessage, SendPreparationState } from "../../domain/changes.js";
import type { ProviderAdapter, SendPreparation } from "../adapter.js";
import { newMessageId } from "../../mime/message-id.js";
import { PlatformCrypto } from "../../platform/crypto.js";
import { confirmDelivery, pollDelivery } from "../provider-send.js";
import {
  checkAttachmentSize,
  checkRequestSize,
  draftKey,
  fileAttachment,
  forwardsMessage,
  graphFields,
  keepsInherited,
  needsUpload,
} from "./graph-message.js";
import { PermanentError, ProviderError } from "../../domain/errors.js";
import { GRAPH, SendRequest, WithId, decode, writeFailure } from "./graph.js";
import { uncertainWrite } from "../provider-retry.js";
import { HttpClientRequest } from "effect/http";
import { makeOutlookDrafts } from "./drafts.js";
import { cachedThreading, type SendOriginal } from "../send-original.js";

/** createReply and createForward answer 404 once the original is deleted or purged. */
const originalGone = (error: { readonly _tag: string }) =>
  error._tag === "ApiError" && "status" in error && error.status === 404;

/**
 * A forward that keeps the original's attachments needs Outlook's copy of the original.
 * Without it the attachments cannot be fetched, so the send fails before anything goes out.
 */
const checkInheritedAttachments = (message: OutgoingMessage, original: SendOriginal) =>
  keepsInherited(message) && original.hasAttachments
    ? Effect.fail(
        new PermanentError({
          message:
            "The original message is no longer in Outlook, so its attachments cannot be forwarded. Attach the files yourself or forward without them.",
        }),
      )
    : Effect.void;

export const makeOutlookSend = (client: OutlookClient) =>
  Effect.gen(function* () {
    const { codec, api, get } = client;
    const draftState = yield* makeOutlookDraftState(client);
    const {
      write,
      crypto,
      attachmentProofs,
      draftVersions,
      readDraftVersion,
      deleteInheritedAttachments,
      deliveryLookup,
      draftLookup,
      addDraftAttachments,
      deliver,
      syncUploadedAttachments,
    } = draftState;

    const buildMime = (...args: Parameters<typeof unboundBuildMime>) =>
      unboundBuildMime(...args).pipe(Effect.provideService(MailCodec, codec));

    /**
     * The original is gone from Outlook: send a new message as raw MIME, which keeps the
     * cached In-Reply-To and References. Graph's JSON message only accepts x- headers.
     */
    const sendWithoutOriginal = (
      account: Account,
      message: OutgoingMessage,
      original: SendOriginal,
      messageId: string,
    ) =>
      Effect.gen(function* () {
        yield* checkInheritedAttachments(message, original);
        const mime = yield* buildMime(
          message.from ?? { name: "", address: account.email },
          message,
          cachedThreading(original),
          { messageId },
        );
        const body = mime.toString("base64");
        yield* checkRequestSize(body);
        yield* deliver(
          account.id,
          messageId,
          api(
            account.id,
            HttpClientRequest.post(`${GRAPH}/me/sendMail`).pipe(
              HttpClientRequest.bodyText(body, "text/plain"),
            ),
          ),
        );
      });

    const sendUploaded = (
      account: Account,
      message: OutgoingMessage,
      original: Option.Option<SendOriginal>,
      preparation?: SendPreparation,
    ) =>
      Effect.gen(function* () {
        const loaded = preparation ? yield* preparation.load : Option.none<SendPreparationState>();
        const messageId = Option.isSome(loaded)
          ? loaded.value.messageId
          : yield* newMessageId(account.email).pipe(Effect.provideService(PlatformCrypto, crypto));
        const save = (state: SendPreparationState | null) =>
          preparation ? preparation.save(state) : Effect.void;
        let sendAttempted = false;
        let creationAttempted = false;
        yield* Effect.gen(function* () {
          if (Option.isSome(loaded) && loaded.value.phase === "sending") {
            yield* confirmDelivery(
              deliveryLookup(account.id, messageId).pipe(
                Effect.map((delivery) => delivery.value.length > 0),
              ),
            );
            return;
          }
          const fields = { ...graphFields(message), internetMessageId: messageId };
          yield* checkRequestSize(JSON.stringify(fields));
          let id: string;
          let recovered = false;
          const found = Option.isSome(loaded)
            ? yield* draftLookup(account.id, messageId)
            : undefined;
          const candidate = found?.value[0];
          if (candidate) {
            id = candidate.id;
            recovered = true;
          } else {
            if (
              Option.isSome(loaded) &&
              (yield* pollDelivery(
                deliveryLookup(account.id, messageId).pipe(
                  Effect.map((delivery) => delivery.value.length > 0),
                ),
                {
                  delays: [0, 1000, 2000],
                  timeout: 5000,
                },
              ).pipe(
                Effect.catchTag("TimeoutError", () =>
                  Effect.fail(new ProviderError({ message: "Outlook delivery lookup timed out" })),
                ),
              ))
            )
              return;
            yield* save({ phase: "creating", messageId });
            creationAttempted = true;
            const mode = message.mode ?? "new";
            const reply = Option.isSome(original) && mode !== "new";
            const action =
              mode === "forward"
                ? "createForward"
                : mode === "reply"
                  ? "createReply"
                  : "createReplyAll";
            const newDraft = write(account.id, "POST", "/me/messages", fields);
            // An original deleted since sync answers 404. Large attachments need an upload
            // session on a draft, and Graph drafts take no In-Reply-To, so this one goes out unthreaded.
            let threaded = reply;
            const created = yield* (
              reply && Option.isSome(original)
                ? write(
                    account.id,
                    "POST",
                    `/me/messages/${encodeURIComponent(original.value.providerId)}/${action}`,
                    { message: { internetMessageId: messageId } },
                  ).pipe(
                    Effect.catchIf(originalGone, () =>
                      checkInheritedAttachments(message, original.value).pipe(
                        Effect.andThen(
                          Effect.suspend(() => {
                            threaded = false;
                            return newDraft;
                          }),
                        ),
                      ),
                    ),
                  )
                : newDraft
            ).pipe(
              Effect.flatMap(decode(WithId)),
              Effect.catchIf(
                (error) =>
                  error._tag === "PermanentError" ||
                  (error._tag === "ApiError" && !uncertainWrite(error)),
                (error) => save(null).pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
            id = created.id;
            // createReply/createForward can assign their own Message-ID. Establish ours before adoption.
            if (threaded)
              yield* write(account.id, "PATCH", `/me/messages/${encodeURIComponent(id)}`, fields);
          }
          const path = `/me/messages/${encodeURIComponent(id)}`;
          yield* save({ phase: "preparing", messageId, draftId: id });
          if (recovered) {
            if (attachmentProofs.has(draftKey(account.id, id)))
              yield* readDraftVersion(account.id, id);
            yield* write(account.id, "PATCH", path, fields);
          }
          if (!recovered && message.mode === "forward" && !keepsInherited(message))
            yield* deleteInheritedAttachments(account.id, path);
          yield* syncUploadedAttachments(
            account.id,
            id,
            message,
            recovered,
            recovered && !keepsInherited(message),
          );
          yield* save({ phase: "sending", messageId, draftId: id });
          sendAttempted = true;
          yield* deliver(account.id, messageId, write(account.id, "POST", `${path}/send`)).pipe(
            Effect.tapError((error) =>
              error._tag === "SendUncertain"
                ? Effect.void
                : Effect.gen(function* () {
                    sendAttempted = false;
                    yield* save({ phase: "preparing", messageId, draftId: id });
                  }),
            ),
          );
          attachmentProofs.delete(draftKey(account.id, id));
          draftVersions.delete(draftKey(account.id, id));
          return;
        }).pipe(
          Effect.onError(() =>
            preparation || sendAttempted || !creationAttempted
              ? Effect.void
              : draftLookup(account.id, messageId).pipe(
                  Effect.flatMap((found) =>
                    Effect.forEach(
                      found.value,
                      (draft) =>
                        write(account.id, "DELETE", `/me/messages/${encodeURIComponent(draft.id)}`),
                      { discard: true },
                    ),
                  ),
                  Effect.catch(() => Effect.void),
                ),
          ),
        );
      });

    const send = Effect.fn("Outlook.send")(
      function* (
        account: Account,
        message: OutgoingMessage,
        original: Option.Option<SendOriginal>,
        preparation?: SendPreparation,
      ) {
        yield* checkAttachmentSize(message);
        const prior = preparation ? yield* preparation.load : Option.none<SendPreparationState>();
        if (
          (Option.isSome(prior) &&
            (prior.value.phase === "sending" || !forwardsMessage(message))) ||
          (!forwardsMessage(message) && needsUpload(message))
        ) {
          yield* sendUploaded(account, message, original, preparation);
          return;
        }
        const messageId = yield* newMessageId(account.email).pipe(
          Effect.provideService(PlatformCrypto, crypto),
        );
        const fields = { ...graphFields(message), internetMessageId: messageId };
        const attachments = message.attachments.map(fileAttachment);
        const mode = message.mode ?? "new";
        if ((Option.isNone(original) || mode === "new") && forwardsMessage(message)) {
          // A forwarded .eml goes out as raw MIME, which Graph's sendMail also
          // takes: as a JSON fileAttachment Exchange re-encodes the .eml as an
          // opaque base64 file, and Gmail previews it as text in a guessed
          // charset. In MIME it is a real message/rfc822 part.
          const mime = yield* buildMime(
            { name: "", address: account.email },
            message,
            {},
            { messageId },
          );
          const body = mime.toString("base64");
          yield* checkRequestSize(body);
          yield* deliver(
            account.id,
            messageId,
            api(
              account.id,
              HttpClientRequest.post(`${GRAPH}/me/sendMail`).pipe(
                HttpClientRequest.bodyText(body, "text/plain"),
              ),
            ),
          );
        } else if (Option.isNone(original) || mode === "new") {
          yield* checkRequestSize(
            JSON.stringify({ message: { ...fields, attachments }, saveToSentItems: true }),
          );
          yield* deliver(
            account.id,
            messageId,
            write(account.id, "POST", "/me/sendMail", {
              message: { ...fields, attachments },
              saveToSentItems: true,
            }),
          );
        } else {
          // Replies and forwards go through a draft so Outlook sets the threading
          // headers and conversation itself.
          const action = {
            reply: "createReply",
            replyAll: "createReplyAll",
            forward: "createForward",
          }[mode];
          const created = yield* write(
            account.id,
            "POST",
            `/me/messages/${encodeURIComponent(original.value.providerId)}/${action}`,
            { message: { internetMessageId: messageId } },
          ).pipe(
            Effect.flatMap(decode(WithId)),
            Effect.map(Option.some),
            Effect.catchIf(originalGone, () => Effect.succeed(Option.none())),
            Effect.catchIf(
              (error) => error._tag === "ApiError" && uncertainWrite(error),
              (error) => {
                // A conversation/time match can belong to another composer.
                // Only the random Message-ID identifies a disposable send draft.
                const cleanup = draftLookup(account.id, messageId).pipe(
                  Effect.flatMap((found) =>
                    Effect.forEach(
                      found.value,
                      (orphan) =>
                        write(
                          account.id,
                          "DELETE",
                          `/me/messages/${encodeURIComponent(orphan.id)}`,
                        ),
                      { discard: true },
                    ).pipe(Effect.as(found.value.length > 0)),
                  ),
                );
                return confirmDelivery(cleanup).pipe(
                  Effect.result,
                  Effect.asVoid,
                  Effect.andThen(Effect.fail(error)),
                );
              },
            ),
          );
          if (Option.isNone(created)) {
            yield* sendWithoutOriginal(account, message, original.value, messageId);
            return;
          }
          const draft = created.value;
          const path = `/me/messages/${encodeURIComponent(draft.id)}`;
          let sendAttempted = false;
          yield* Effect.gen(function* () {
            yield* write(account.id, "PATCH", path, fields);
            if (mode === "forward" && !keepsInherited(message))
              yield* deleteInheritedAttachments(account.id, path);
            yield* addDraftAttachments(account.id, draft.id, attachments);
            sendAttempted = true;
            yield* deliver(account.id, messageId, write(account.id, "POST", `${path}/send`));
          }).pipe(
            Effect.onError(() =>
              (sendAttempted
                ? get(
                    account.id,
                    Schema.Struct({ isDraft: Schema.Boolean }),
                    `${path}?$select=isDraft`,
                  ).pipe(
                    Effect.flatMap((current) =>
                      current.isDraft ? write(account.id, "DELETE", path) : Effect.void,
                    ),
                  )
                : write(account.id, "DELETE", path)
              ).pipe(Effect.catch(() => Effect.void)),
            ),
          );
        }
        return;
      },
      (effect, account) =>
        Effect.mapError(effect.pipe(Effect.provideService(SendRequest, true)), (error) =>
          error._tag === "SendUncertain" ? error : writeFailure(account.id)(error),
        ),
    );

    const { saveDraft, deleteDraft, draftMarkdownSource } = makeOutlookDrafts(client, draftState);

    return {
      send,
      saveDraft,
      draftVersion: (account, id) =>
        readDraftVersion(account.id, id).pipe(Effect.mapError(writeFailure(account.id))),
      getDraftOrganization: (account, id) =>
        get(
          account.id,
          Schema.Struct({
            categories: Schema.optionalKey(Schema.Array(Schema.String)),
            flag: Schema.optionalKey(
              Schema.Struct({ flagStatus: Schema.optionalKey(Schema.String) }),
            ),
          }),
          `/me/messages/${encodeURIComponent(id)}?$select=categories,flag`,
        ).pipe(
          Effect.map((message) => ({
            labels: message.categories ?? [],
            starred: message.flag?.flagStatus === "flagged",
          })),
          Effect.mapError(writeFailure(account.id)),
        ),
      deleteDraft,
      draftMarkdownSource,
    } satisfies Pick<
      ProviderAdapter,
      | "send"
      | "saveDraft"
      | "draftVersion"
      | "getDraftOrganization"
      | "deleteDraft"
      | "draftMarkdownSource"
    >;
  });
