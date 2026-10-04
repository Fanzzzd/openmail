import { Clock, Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { attachmentProblem, attachmentProblemMessage } from "../attachment-policy.js";
import { composeTransportHtml } from "../compose-body.js";
import { buildMime as unboundBuildMime } from "../compose.js";
import type { Account, Address, DraftRemote, OutgoingMessage } from "../domain.js";
import { draftVersionMetadata } from "../draft-version.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../errors.js";
import { MarkdownDraftSource, markdownDraftSource } from "../markdown-draft.js";
import { newMessageId } from "../message-id.js";
import { htmlDocument } from "../mime.js";
import { PlatformCrypto } from "../platform/crypto.js";
import { MailCodec } from "../platform/mail-codec.js";
import { ApiError } from "../provider-http.js";
import { graphPages } from "../provider-pages.js";
import { uncertainWrite } from "../provider-retry.js";
import { confirmDelivery, deliverOrConfirm } from "../provider-send.js";
import { type DraftPush, type DraftSaveResult, type ProviderAdapter } from "../services.js";
import type { GraphClient } from "./client.js";
import {
  AttachmentIds,
  decode,
  DraftVersion,
  GRAPH,
  is404,
  nextPage,
  REQUEST_LIMIT,
  SendRequest,
  UploadedAttachments,
  WithId,
  writeFailure,
} from "./graph.js";

export const makeOutlookSend = (client: GraphClient) =>
  Effect.gen(function* () {
    const { codec, api, get, write } = client;

    const inFlightSendDrafts = new Map<symbol, string | null>();

    const crypto = yield* PlatformCrypto;

    const buildMime = (...args: Parameters<typeof unboundBuildMime>) =>
      unboundBuildMime(...args).pipe(Effect.provideService(MailCodec, codec));

    const readDraftVersion = (accountId: string, id: string) =>
      get(
        accountId,
        DraftVersion,
        `/me/messages/${encodeURIComponent(id)}?$select=id,changeKey,lastModifiedDateTime`,
      );

    const deliveryLookup = (accountId: string, messageId: string, folder = "sentitems") =>
      get(
        accountId,
        Schema.Struct({ value: Schema.Array(WithId) }),
        `/me/mailFolders/${folder}/messages?${new URLSearchParams({ $filter: `internetMessageId eq '${messageId.replaceAll("'", "''")}'`, $select: "id", $top: "1" }).toString()}`,
      );

    const replyDraftLookup = (
      accountId: string,
      sourceId: string,
      messageId: string,
      attemptedAt: number,
      isLinked: DraftPush["creation"]["isLinked"],
    ) =>
      Effect.gen(function* () {
        const identified = yield* deliveryLookup(accountId, messageId, "drafts");
        if (identified.value.length) return identified;
        const source = yield* get(
          accountId,
          Schema.Struct({ conversationId: Schema.String }),
          `/me/messages/${encodeURIComponent(sourceId)}?$select=conversationId`,
        );
        const skew = 5000;
        const from = new Date(attemptedAt - skew).toISOString();
        const until = new Date(attemptedAt + 2 * 60_000).toISOString();
        const found = yield* get(
          accountId,
          Schema.Struct({
            "@odata.nextLink": Schema.optionalKey(Schema.String),
            value: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                conversationId: Schema.String,
                createdDateTime: Schema.String,
                lastModifiedDateTime: Schema.optionalKey(Schema.String),
                isDraft: Schema.optionalKey(Schema.Boolean),
              }),
            ),
          }),
          `/me/mailFolders/drafts/messages?${new URLSearchParams({ $filter: `conversationId eq '${source.conversationId.replaceAll("'", "''")}' and createdDateTime ge ${from} and createdDateTime le ${until}`, $select: "id,conversationId,createdDateTime,lastModifiedDateTime,isDraft", $top: "2" }).toString()}`,
        );
        const candidates = yield* Effect.filter(found.value, (entry) =>
          Effect.gen(function* () {
            const created = Date.parse(entry.createdDateTime);
            const modified = Date.parse(entry.lastModifiedDateTime ?? "");
            return (
              entry.conversationId === source.conversationId &&
              created >= attemptedAt - skew &&
              created <= attemptedAt + 2 * 60_000 &&
              entry.isDraft === true &&
              modified >= created &&
              modified - created <= skew &&
              ![...inFlightSendDrafts.values()].some((id) => id === null || id === entry.id) &&
              !(yield* isLinked(entry.id))
            );
          }),
        );
        // Ambiguity counts as a miss, allowing the durable retry bound to advance.
        return { value: candidates.length === 1 && !found["@odata.nextLink"] ? candidates : [] };
      });

    const listDraftAttachments = (accountId: string, id: string) =>
      Effect.gen(function* () {
        const path = `/me/messages/${encodeURIComponent(id)}/attachments`;
        let next: string | undefined = path;
        const seen = new Set<string>();
        const attachments: (typeof UploadedAttachments.Type)["value"][number][] = [];
        for (const loadPage of graphPages(
          next,
          (pagePath) =>
            Effect.gen(function* () {
              if (seen.has(pagePath))
                return yield* new ProviderError({
                  message: "Attachment pagination repeated a page",
                });
              seen.add(pagePath);

              return yield* get(accountId, UploadedAttachments, pagePath);
            }),
          () => next,
        )) {
          const page: typeof UploadedAttachments.Type = yield* loadPage;

          attachments.push(...page.value);
          next = page["@odata.nextLink"]
            ? yield* nextPage(
                page["@odata.nextLink"],
                path,
                undefined,
                () => new ProviderError({ message: "Invalid attachment pagination link" }),
              )
            : undefined;
        }
        return attachments;
      });

    const addDraftAttachments = (
      accountId: string,
      id: string,
      attachments: readonly ReturnType<typeof fileAttachment>[],
      reconcile = false,
    ) =>
      Effect.gen(function* () {
        const added: ReturnType<typeof fileAttachment>[] = [];
        const same = (
          a: Pick<ReturnType<typeof fileAttachment>, "name" | "contentBytes" | "contentId">,
          b: Pick<
            (typeof UploadedAttachments.Type)["value"][number],
            "name" | "contentBytes" | "contentId"
          >,
        ) =>
          a.name === b.name &&
          a.contentBytes === b.contentBytes &&
          (a.contentId ?? null) === (b.contentId ?? null);
        const existing = reconcile ? yield* listDraftAttachments(accountId, id) : [];
        for (const attachment of attachments) {
          const present = existing.findIndex((candidate) => same(attachment, candidate));
          if (present >= 0) {
            existing.splice(present, 1);
            added.push(attachment);
            continue;
          }
          yield* write(
            accountId,
            "POST",
            `/me/messages/${encodeURIComponent(id)}/attachments`,
            attachment,
          ).pipe(
            Effect.catchIf(
              (error) => error._tag === "ApiError" && uncertainWrite(error),
              (error) =>
                Effect.gen(function* () {
                  const current = yield* listDraftAttachments(accountId, id);
                  const required = 1 + added.filter((prior) => same(prior, attachment)).length;
                  if (current.filter((candidate) => same(attachment, candidate)).length < required)
                    yield* Effect.fail(error);
                }),
            ),
          );
          added.push(attachment);
        }
      });

    const deliver = (accountId: string, messageId: string, effect: ReturnType<typeof api>) =>
      deliverOrConfirm(
        effect,
        deliveryLookup(accountId, messageId).pipe(Effect.map((found) => !!found.value.length)),
        (error) => error._tag === "ApiError" && uncertainWrite(error),
      );

    const send = Effect.fn("Outlook.send")(
      function* (
        account: Account,
        message: OutgoingMessage,
        original: Option.Option<{ providerId: string; threadId: string }>,
      ) {
        yield* checkAttachmentSize(message);
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
          const token = Symbol();
          yield* Effect.gen(function* () {
            // Until createReply returns its ID, any template could be this send's copy.
            inFlightSendDrafts.set(token, null);
            const draft = yield* write(
              account.id,
              "POST",
              `/me/messages/${encodeURIComponent(original.value.providerId)}/${action}`,
              { message: { internetMessageId: messageId } },
            ).pipe(
              Effect.flatMap(decode(WithId)),
              Effect.catchIf(
                (error) => error._tag === "ApiError" && uncertainWrite(error),
                (error) => {
                  // A conversation/time match can belong to another composer.
                  // Only the random Message-ID identifies a disposable send draft.
                  const cleanup = deliveryLookup(account.id, messageId, "drafts").pipe(
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
            const path = `/me/messages/${encodeURIComponent(draft.id)}`;
            inFlightSendDrafts.set(token, draft.id);
            let sendAttempted = false;
            yield* Effect.gen(function* () {
              yield* write(account.id, "PATCH", path, fields);
              if (mode === "forward" && message.includeOriginalAttachments !== undefined) {
                const inherited = yield* get(
                  account.id,
                  AttachmentIds,
                  `/me/messages/${encodeURIComponent(draft.id)}/attachments?$select=id,isInline,contentId`,
                );
                for (const attachment of inherited.value)
                  yield* write(
                    account.id,
                    "DELETE",
                    `/me/messages/${encodeURIComponent(draft.id)}/attachments/${encodeURIComponent(attachment.id)}`,
                  );
              }
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
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                inFlightSendDrafts.delete(token);
              }),
            ),
          );
        }
      },
      (effect, account) =>
        Effect.mapError(effect.pipe(Effect.provideService(SendRequest, true)), (error) =>
          error._tag === "SendUncertain" ? error : writeFailure(account.id)(error),
        ),
    );

    /**
     * Outlook drafts are messages in the Drafts folder, edited in place, so the
     * id stays the same across saves. Replies are created with createReply so
     * Outlook threads them; new messages use plain drafts. Forwards inherit the original attachments
     * on the server, so large originals never enter the upload path.
     */
    const saveDraft = Effect.fn("Outlook.saveDraft")(
      function* (account: Account, draft: DraftPush) {
        const { message, original } = draft;
        yield* checkAttachmentSize(message);
        const fields = {
          ...graphFields(message),
          ...(message.draftOrganization
            ? {
                categories: message.draftOrganization.labels,
                flag: { flagStatus: message.draftOrganization.starred ? "flagged" : "notFlagged" },
              }
            : {}),
          singleValueExtendedProperties: [
            {
              id: MARKDOWN_DRAFT_PROPERTY,
              value: message.markdown ? JSON.stringify(markdownDraftSource(message.text)) : "",
            },
          ],
        };
        const attachments = message.attachments.map(fileAttachment);
        const addAttachments = (id: string, reconcile = false) =>
          addDraftAttachments(account.id, id, attachments, reconcile);
        let saveError: ProviderFailure | undefined;
        let changeKey: string | undefined;
        let lastWrittenAt = draft.remote?.lastWrittenAt;
        let patchedId: string | undefined;
        const captureVersion = (version: typeof DraftVersion.Type) =>
          Effect.sync(() => {
            const metadata = draftVersionMetadata(version);
            changeKey = metadata.changeKey;
            lastWrittenAt = metadata.lastWrittenAt;
          });
        let conflict = false;
        let replacedMessageId: string | undefined;
        const remember = (id: string, version?: string) => {
          changeKey = version;
          return draft.creation.remember({
            draftId: id,
            messageId: id,
            ...(version ? { changeKey: version } : {}),
            ...(lastWrittenAt === undefined ? {} : { lastWrittenAt }),
          });
        };
        const afterWriteFailure = (id: string, error: ApiError | ProviderFailure) =>
          Effect.gen(function* () {
            saveError = writeFailure(account.id)(error);
            const current = yield* readDraftVersion(account.id, id).pipe(Effect.option);
            if (Option.isSome(current)) yield* captureVersion(current.value);
            else {
              changeKey = undefined;
              lastWrittenAt = undefined;
            }
            yield* remember(id, changeKey);
            return id;
          });
        const finishCreated = (
          id: string,
          mode: string,
          identified: boolean,
          reconcile = false,
          messageId?: string,
        ) =>
          Effect.gen(function* () {
            if (identified) {
              const updated = yield* write(
                account.id,
                "PATCH",
                `/me/messages/${encodeURIComponent(id)}`,
                { ...fields, ...(messageId ? { internetMessageId: messageId } : {}) },
              ).pipe(Effect.flatMap(decode(DraftVersion)));
              yield* captureVersion(updated);
              patchedId = id;
              if (mode === "forward" && message.includeOriginalAttachments !== undefined) {
                const inherited = yield* get(
                  account.id,
                  AttachmentIds,
                  `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,isInline,contentId`,
                );
                for (const attachment of inherited.value)
                  yield* write(
                    account.id,
                    "DELETE",
                    `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment.id)}`,
                  );
              }
              yield* addAttachments(id, reconcile);
              if (changeKey) yield* captureVersion(yield* readDraftVersion(account.id, id));
            }
            return id;
          }).pipe(Effect.catch((error) => afterWriteFailure(id, error)));
        const create = Effect.gen(function* () {
          const mode = message.mode ?? "new";
          const state = yield* draft.creation.begin();
          const reply = Option.isSome(original) && mode !== "new";
          const attemptedAt = state.attemptedAt ?? (yield* Clock.currentTimeMillis);
          // Graph does not promise to preserve a supplied ID in createReply/createForward.
          // https://learn.microsoft.com/en-us/graph/api/message-update#request-body
          const lookup =
            reply && Option.isSome(original)
              ? replyDraftLookup(
                  account.id,
                  original.value.providerId,
                  state.messageId,
                  attemptedAt,
                  draft.creation.isLinked,
                )
              : deliveryLookup(account.id, state.messageId, "drafts");
          if (state.attempted) {
            const found = yield* lookup;
            const existing = found.value[0];
            if (existing) {
              yield* remember(existing.id);
              return yield* finishCreated(existing.id, mode, true, true, state.messageId);
            }
            if (!(yield* draft.creation.missing()))
              return yield* new ProviderError({
                message:
                  "Draft creation is uncertain. Waiting for the provider copy before creating another draft.",
              });
          }
          const action =
            mode === "forward"
              ? "createForward"
              : mode === "reply"
                ? "createReply"
                : "createReplyAll";
          yield* draft.creation.attempted(state.messageId);
          let recovered = false;
          const created = yield* write(
            account.id,
            "POST",
            reply && Option.isSome(original)
              ? `/me/messages/${encodeURIComponent(original.value.providerId)}/${action}`
              : "/me/messages",
            reply
              ? { message: { internetMessageId: state.messageId } }
              : { ...fields, internetMessageId: state.messageId, attachments },
          ).pipe(
            Effect.flatMap(decode(DraftVersion)),
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (error._tag === "ApiError" && uncertainWrite(error)) {
                  const found = yield* lookup;
                  const existing = found.value[0];
                  if (existing) {
                    recovered = true;
                    return existing;
                  }
                } else if (error._tag === "ApiError")
                  yield* draft.creation.attempted(state.messageId, false);
                return yield* Effect.fail(error);
              }),
            ),
          );
          if (!created.id)
            return yield* new ProviderError({ message: "Created draft response has no ID" });
          yield* captureVersion(created);
          yield* remember(created.id, changeKey);
          return yield* finishCreated(created.id, mode, reply, recovered, state.messageId);
        });

        const update = (id: string) =>
          Effect.gen(function* () {
            // Recreate the server-side forward when uploaded parts change. Its inherited
            // parts are opaque to the upload list and must never be deleted with it.
            if (
              message.mode === "forward" &&
              message.includeOriginalAttachments === undefined &&
              draft.replaceAttachments &&
              Option.isSome(original)
            ) {
              // This replaces the message. Read live metadata instead of replaying
              // stale local intent when another client changed its categories/flag.
              if (message.draftOrganization === undefined) {
                const live = yield* get(
                  account.id,
                  Schema.Struct({
                    categories: Schema.optionalKey(Schema.Array(Schema.String)),
                    flag: Schema.optionalKey(
                      Schema.Struct({ flagStatus: Schema.optionalKey(Schema.String) }),
                    ),
                  }),
                  `/me/messages/${encodeURIComponent(id)}?$select=categories,flag`,
                ).pipe(
                  Effect.catchIf(is404, () =>
                    Effect.succeed({ categories: undefined, flag: undefined }),
                  ),
                );
                if (live.categories) fields.categories = live.categories;
                if (live.flag?.flagStatus) fields.flag = { flagStatus: live.flag.flagStatus };
              }
              const next = yield* create;
              const deleted = yield* write(
                account.id,
                "DELETE",
                `/me/messages/${encodeURIComponent(id)}`,
              ).pipe(
                Effect.catchIf(is404, () => Effect.void),
                Effect.result,
              );
              if (deleted._tag === "Failure") replacedMessageId = id;
              return next;
            }
            // Only this PATCH's 404 means the draft disappeared. Later attachment
            // failures must retain this ID instead of creating another message.
            const patched = yield* write(
              account.id,
              "PATCH",
              `/me/messages/${encodeURIComponent(id)}`,
              fields,
            ).pipe(
              Effect.flatMap(decode(DraftVersion)),
              Effect.map(Option.some),
              Effect.catchIf(is404, () => Effect.succeed(Option.none())),
            );
            if (Option.isNone(patched)) return yield* create;
            yield* captureVersion(patched.value);
            patchedId = id;
            yield* remember(id, changeKey);
            if (!draft.replaceAttachments) return id;
            const current = yield* get(
              account.id,
              AttachmentIds,
              `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,isInline,contentId`,
            );
            const managedInline = new Set(
              message.attachments.flatMap((attachment) =>
                attachment.contentId ? [attachment.contentId] : [],
              ),
            );
            for (const a of current.value.filter(
              (x) =>
                (message.mode === "forward" && message.includeOriginalAttachments !== undefined) ||
                !x.isInline ||
                (x.contentId !== null &&
                  x.contentId !== undefined &&
                  managedInline.has(x.contentId)),
            )) {
              yield* write(
                account.id,
                "DELETE",
                `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(a.id)}`,
              );
            }
            yield* addAttachments(id);
            if (changeKey) yield* captureVersion(yield* readDraftVersion(account.id, id));
            return id;
          }).pipe(
            Effect.catch((error) =>
              patchedId ? afterWriteFailure(patchedId, error) : Effect.fail(error),
            ),
          );

        const known = draft.remote?.messageId ?? draft.remote?.draftId;
        // Deleted in another client meanwhile: the person is still writing it.
        if (known && draft.remote?.changeKey) {
          const live = yield* readDraftVersion(account.id, known).pipe(
            Effect.map(Option.some),
            Effect.catchIf(is404, () => Effect.succeed(Option.none())),
          );
          conflict =
            Option.isSome(live) &&
            live.value.changeKey !== draft.remote.changeKey &&
            draft.remote.lastWrittenAt !== undefined &&
            Date.parse(live.value.lastModifiedDateTime ?? "") > draft.remote.lastWrittenAt;
        }
        const id = known && !conflict ? yield* update(known) : yield* create;
        return {
          draftId: id,
          messageId: id,
          ...(changeKey ? { changeKey } : {}),
          ...(lastWrittenAt === undefined ? {} : { lastWrittenAt }),
          ...(conflict ? { conflict: true } : {}),
          ...(saveError ? { saveError } : {}),
          ...(replacedMessageId ? { replacedMessageId } : {}),
        } satisfies DraftSaveResult;
      },
      (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
    );

    const deleteDraft = Effect.fn("Outlook.deleteDraft")(
      function* (account: Account, remote: DraftRemote) {
        const remove = (id: string) =>
          write(account.id, "DELETE", `/me/messages/${encodeURIComponent(id)}`).pipe(
            Effect.catchIf(is404, () => Effect.void),
          );
        const id = remote.messageId ?? remote.draftId;
        if (id) {
          yield* remove(id);
          return;
        }
        if (!remote.rfcMessageId) return;
        const base = "/me/mailFolders/drafts/messages";
        let next: string | undefined =
          `${base}?${new URLSearchParams({ $filter: `internetMessageId eq '${remote.rfcMessageId.replaceAll("'", "''")}' and isDraft eq true`, $select: "id", $top: "100" }).toString()}`;
        const seen = new Set<string>();
        const Page = Schema.Struct({
          value: Schema.Array(WithId),
          "@odata.nextLink": Schema.optionalKey(Schema.String),
        });
        for (const loadPage of graphPages(
          next,
          (pagePath) =>
            Effect.gen(function* () {
              if (seen.has(pagePath))
                yield* new ProviderError({ message: "Draft cleanup pagination repeated a page" });
              seen.add(pagePath);

              return yield* get(account.id, Page, pagePath);
            }),
          () => next,
        )) {
          const page: typeof Page.Type = yield* loadPage;

          for (const draft of page.value) yield* remove(draft.id);
          next = page["@odata.nextLink"]
            ? yield* nextPage(
                page["@odata.nextLink"],
                base,
                undefined,
                () => new ProviderError({ message: "Invalid draft cleanup pagination link" }),
              )
            : undefined;
        }
      },
      (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
    );

    const draftMarkdownSource = Effect.fn("Outlook.draftMarkdownSource")(
      function* (account: Account, providerId: string) {
        const metadata = yield* get(
          account.id,
          Schema.Struct({
            singleValueExtendedProperties: Schema.optionalKey(
              Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
            ),
          }),
          `/me/messages/${encodeURIComponent(providerId)}?$select=id&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${MARKDOWN_DRAFT_PROPERTY}')`)}`,
        );
        const value = metadata.singleValueExtendedProperties?.find(
          (property) => property.id === MARKDOWN_DRAFT_PROPERTY,
        )?.value;
        return value
          ? Option.getOrUndefined(
              Schema.decodeUnknownOption(Schema.fromJsonString(MarkdownDraftSource))(value),
            )
          : undefined;
      },
      (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
    );
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

export function fileAttachment(a: OutgoingMessage["attachments"][number]) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.mimeType,
    contentBytes: a.content,
    ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
  };
}

export const recipients = (list: readonly Address[]) =>
  list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));

/** Custom internet headers are create-only; this property also supports draft updates. */
export const MARKDOWN_DRAFT_PROPERTY =
  "String {57d14d35-4d11-4f8f-ae63-961883378d87} Name OpenmailMarkdownSource";

export function graphFields(message: OutgoingMessage) {
  return {
    subject: message.subject,
    body: message.html
      ? { contentType: "html", content: htmlDocument(composeTransportHtml(message) ?? "") }
      : { contentType: "text", content: message.text },
    toRecipients: recipients(message.to),
    ccRecipients: recipients(message.cc),
    bccRecipients: recipients(message.bcc),
  };
}

export const checkRequestSize = (body: string) =>
  body.length > REQUEST_LIMIT
    ? Effect.fail(
        new PermanentError({
          message: "Outlook messages over 3 MB with a forwarded message are not supported yet",
        }),
      )
    : Effect.void;

export const forwardsMessage = (message: OutgoingMessage) =>
  message.attachments.some((a) => a.mimeType.toLowerCase() === "message/rfc822");

export const checkAttachmentSize = (message: OutgoingMessage) => {
  const problem = attachmentProblem("outlook", message.attachments);
  return problem
    ? Effect.fail(new PermanentError({ message: attachmentProblemMessage(problem) }))
    : Effect.void;
};
