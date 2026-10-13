import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import {
  attachmentBytes,
  attachmentProblem,
  attachmentProblemMessage,
} from "../attachment-policy.js";
import { composeTransportHtml } from "../compose-body.js";
import { buildMime as unboundBuildMime } from "../compose.js";
import type {
  Account,
  Address,
  DraftRemote,
  OutgoingMessage,
  SendPreparationState,
} from "../domain/domain.js";
import { draftVersionMetadata } from "../draft-version.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../domain/errors.js";
import { MarkdownDraftSource, markdownDraftSource } from "../markdown-draft.js";
import { newMessageId } from "../message-id.js";
import { htmlDocument } from "../mime.js";
import { PlatformCrypto } from "../platform/crypto.js";
import { MailCodec } from "../platform/mail-codec.js";
import { Buffer } from "../platform/bytes.js";
import { ApiError } from "../provider-http.js";
import { graphPages } from "../provider-pages.js";
import { uncertainWrite } from "../provider-retry.js";
import { confirmDelivery, deliverOrConfirm, pollDelivery } from "../provider-send.js";
import {
  type DraftPush,
  type DraftSaveResult,
  type ProviderAdapter,
  type SendPreparation,
} from "../services.js";
import { attachmentRange, largeAttachment, makeAttachmentUpload } from "./upload.js";
import type { OutlookClient } from "./client.js";
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

export const makeOutlookSend = (client: OutlookClient) =>
  Effect.gen(function* () {
    const { codec, api, get } = client;

    const crypto = yield* PlatformCrypto;
    const uploadAttachment = yield* makeAttachmentUpload(client);

    const buildMime = (...args: Parameters<typeof unboundBuildMime>) =>
      unboundBuildMime(...args).pipe(Effect.provideService(MailCodec, codec));

    // Verified byte fingerprints survive our body-only PATCHes, but not external version changes.
    const attachmentProofs = new Map<string, Map<string, string>>();
    const draftVersions = new Map<string, string>();
    const recordVersion = (
      accountId: string,
      id: string,
      version: string | undefined,
      ownWrite = false,
    ) => {
      const key = draftKey(accountId, id);
      if (!version || (!ownWrite && draftVersions.get(key) !== version))
        attachmentProofs.delete(key);
      if (version) draftVersions.set(key, version);
      else draftVersions.delete(key);
    };
    const write: typeof client.write = (accountId, method, path, body) =>
      client.write(accountId, method, path, body).pipe(
        Effect.tap((json) =>
          Effect.sync(() => {
            const version = Schema.decodeUnknownOption(DraftVersion)(json);
            if (Option.isSome(version) && version.value.id && version.value.changeKey)
              recordVersion(accountId, version.value.id, version.value.changeKey, true);
          }),
        ),
      );
    const readDraftVersion = (accountId: string, id: string) =>
      get(
        accountId,
        DraftVersion,
        `/me/messages/${encodeURIComponent(id)}?$select=id,changeKey,lastModifiedDateTime`,
      ).pipe(
        Effect.tap((version) => Effect.sync(() => recordVersion(accountId, id, version.changeKey))),
      );
    const deleteInheritedAttachments = (accountId: string, path: string) =>
      Effect.gen(function* () {
        const inherited = yield* get(
          accountId,
          AttachmentIds,
          `${path}/attachments?$select=id,isInline,contentId`,
        );
        for (const attachment of inherited.value)
          yield* write(
            accountId,
            "DELETE",
            `${path}/attachments/${encodeURIComponent(attachment.id)}`,
          );
      });

    const deliveryLookup = (accountId: string, messageId: string) =>
      get(
        accountId,
        Schema.Struct({ value: Schema.Array(WithId) }),
        `/me/mailFolders/sentitems/messages?${new URLSearchParams({ $filter: `internetMessageId eq '${messageId.replaceAll("'", "''")}'`, $select: "id", $top: "1" }).toString()}`,
      );

    /** Only our exact random Message-ID proves ownership; dates and conversations do not. */
    const draftLookup = (accountId: string, messageId: string) =>
      get(
        accountId,
        Schema.Struct({
          value: Schema.Array(WithId),
          "@odata.nextLink": Schema.optionalKey(Schema.String),
        }),
        `/me/mailFolders/drafts/messages?${new URLSearchParams({
          $filter: `internetMessageId eq '${messageId.replaceAll("'", "''")}' and isDraft eq true`,
          $select: "id",
          $top: "2",
        }).toString()}`,
      ).pipe(
        Effect.map((found) => ({
          value: found.value.length === 1 && !found["@odata.nextLink"] ? found.value : [],
        })),
      );

    const listDraftAttachments = (accountId: string, id: string, metadataOnly = false) =>
      Effect.gen(function* () {
        const path = `/me/messages/${encodeURIComponent(id)}/attachments`;
        let next: string | undefined = metadataOnly
          ? `${path}?$select=id,name,contentType,size,contentId,isInline`
          : path;
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

    const deliver = (accountId: string, messageId: string, effect: ReturnType<typeof write>) =>
      deliverOrConfirm(
        effect,
        deliveryLookup(accountId, messageId).pipe(Effect.map((found) => !!found.value.length)),
        (error) => error._tag === "ApiError" && uncertainWrite(error),
      );

    type Uploaded = (typeof UploadedAttachments.Type)["value"][number];
    const findMissing = <E>(
      files: OutgoingMessage["attachments"],
      existing: readonly Uploaded[],
      matches: (
        file: OutgoingMessage["attachments"][number],
        candidate: Uploaded,
      ) => Effect.Effect<boolean, E>,
    ) =>
      Effect.gen(function* () {
        const remaining = [...existing];
        const missing: { file: OutgoingMessage["attachments"][number]; required: number }[] = [];
        for (const [fileIndex, file] of files.entries()) {
          let found = -1;
          for (const [index, candidate] of remaining.entries())
            if (yield* matches(file, candidate)) {
              found = index;
              break;
            }
          if (found < 0)
            missing.push({
              file,
              required:
                1 +
                files
                  .slice(0, fileIndex)
                  .filter(
                    (prior) =>
                      prior.filename === file.filename &&
                      prior.mimeType.toLowerCase() === file.mimeType.toLowerCase() &&
                      prior.content === file.content &&
                      prior.contentId === file.contentId,
                  ).length,
            });
          else remaining.splice(found, 1);
        }
        return { missing, remaining };
      });
    const deleteStale = (
      accountId: string,
      id: string,
      message: OutgoingMessage,
      remaining: readonly Uploaded[],
    ) =>
      Effect.gen(function* () {
        const managed = new Set(
          message.attachments.flatMap((file) => (file.contentId ? [file.contentId] : [])),
        );
        for (const stale of remaining.filter(
          (file) =>
            (message.mode === "forward" && !keepsInherited(message)) ||
            !file.isInline ||
            (file.contentId !== null &&
              file.contentId !== undefined &&
              managed.has(file.contentId)),
        ))
          yield* write(
            accountId,
            "DELETE",
            `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(stale.id)}`,
          );
      });

    // Metadata is only a candidate filter. Content is compared as a stream before reuse.
    const syncUploadedAttachments = (
      accountId: string,
      id: string,
      message: OutgoingMessage,
      reconcile = false,
      replace = false,
    ) =>
      Effect.gen(function* () {
        message = {
          ...message,
          attachments: message.attachments.map((file) =>
            /\s/.test(file.content) ? { ...file, content: file.content.replace(/\s/g, "") } : file,
          ),
        };
        const key = draftKey(accountId, id);
        const fingerprints = new Map<OutgoingMessage["attachments"][number], string>();
        const fingerprint = (file: OutgoingMessage["attachments"][number]) => {
          const known = fingerprints.get(file);
          if (known) return known;
          const chunks: string[] = [];
          for (let start = 0; start < file.content.length; start += 256 * 1024)
            chunks.push(crypto.sha256(file.content.slice(start, start + 256 * 1024)));
          const hash = crypto.sha256(chunks.join(""));
          fingerprints.set(file, hash);
          return hash;
        };
        const matches = (file: OutgoingMessage["attachments"][number], candidate: Uploaded) => {
          if (
            candidate.name !== file.filename ||
            candidate.contentType?.toLowerCase() !== file.mimeType.toLowerCase() ||
            (candidate.isInline ?? !!candidate.contentId) !== !!file.contentId ||
            (candidate.contentId ?? null) !== (file.contentId ?? null)
          )
            return Effect.succeed(false);
          if (candidate.contentBytes !== undefined)
            return Effect.succeed(candidate.contentBytes === file.content);
          const hash = fingerprint(file);
          if (attachmentProofs.get(key)?.get(candidate.id) === hash) return Effect.succeed(true);
          return client
            .matchesAttachment(
              accountId,
              `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(candidate.id)}/$value`,
              attachmentBytes(file.content),
              (start, length) => attachmentRange(file.content, start, length),
            )
            .pipe(
              Effect.tap((same) =>
                Effect.sync(() => {
                  if (same && draftVersions.has(key)) {
                    let proofs = attachmentProofs.get(key);
                    if (!proofs) {
                      proofs = new Map();
                      attachmentProofs.set(key, proofs);
                    }
                    proofs.set(candidate.id, hash);
                  }
                }),
              ),
            );
        };
        const existing = reconcile ? yield* listDraftAttachments(accountId, id, true) : [];
        const { missing, remaining } = yield* findMissing(message.attachments, existing, matches);
        if (replace) yield* deleteStale(accountId, id, message, remaining);
        for (const { file, required } of missing) {
          const exists = () =>
            Effect.gen(function* () {
              const current = yield* listDraftAttachments(accountId, id, true);
              let present = 0;
              for (const candidate of current) if (yield* matches(file, candidate)) present++;
              return present >= required;
            });
          yield* largeAttachment(file)
            ? uploadAttachment(accountId, id, file, exists)
            : write(
                accountId,
                "POST",
                `/me/messages/${encodeURIComponent(id)}/attachments`,
                fileAttachment(file),
              ).pipe(
                Effect.catchIf(
                  (error) => error._tag === "ApiError" && uncertainWrite(error),
                  (error) =>
                    exists().pipe(
                      Effect.flatMap((found) => (found ? Effect.void : Effect.fail(error))),
                    ),
                ),
              );
        }
      });

    const sendUploaded = (
      account: Account,
      message: OutgoingMessage,
      original: Option.Option<{ providerId: string; threadId: string }>,
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
            const created = yield* write(
              account.id,
              "POST",
              reply && Option.isSome(original)
                ? `/me/messages/${encodeURIComponent(original.value.providerId)}/${action}`
                : "/me/messages",
              reply ? { message: { internetMessageId: messageId } } : fields,
            ).pipe(
              Effect.flatMap(decode(WithId)),
              Effect.catchIf(
                (error) => error._tag === "ApiError" && !uncertainWrite(error),
                (error) => save(null).pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
            id = created.id;
            // createReply/createForward can assign their own Message-ID. Establish ours before adoption.
            if (reply)
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
        original: Option.Option<{ providerId: string; threadId: string }>,
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
        const uploaded = needsUpload(message, fields);
        const addAttachments = (id: string, reconcile = false) =>
          uploaded
            ? syncUploadedAttachments(
                account.id,
                id,
                message,
                reconcile,
                reconcile && !keepsInherited(message),
              )
            : addDraftAttachments(account.id, id, attachments, reconcile);
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
              if (mode === "forward" && !keepsInherited(message) && !(uploaded && reconcile))
                yield* deleteInheritedAttachments(
                  account.id,
                  `/me/messages/${encodeURIComponent(id)}`,
                );
              yield* addAttachments(id, reconcile);
              if (changeKey) yield* captureVersion(yield* readDraftVersion(account.id, id));
            } else if (uploaded) {
              yield* addAttachments(id, reconcile);
              if (changeKey) yield* captureVersion(yield* readDraftVersion(account.id, id));
            }
            return id;
          }).pipe(Effect.catch((error) => afterWriteFailure(id, error)));
        const create = Effect.gen(function* () {
          const mode = message.mode ?? "new";
          const state = yield* draft.creation.begin();
          const reply = Option.isSome(original) && mode !== "new";
          // Graph does not promise to preserve a supplied ID in createReply/createForward.
          // https://learn.microsoft.com/en-us/graph/api/message-update#request-body
          const lookup = draftLookup(account.id, state.messageId);
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
              : {
                  ...fields,
                  internetMessageId: state.messageId,
                  ...(uploaded ? {} : { attachments }),
                },
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
          return yield* finishCreated(
            created.id,
            mode,
            reply || (uploaded && recovered),
            recovered,
            state.messageId,
          );
        });

        const update = (id: string) =>
          Effect.gen(function* () {
            // Recreate the server-side forward when uploaded parts change. Its inherited
            // parts are opaque to the upload list and must never be deleted with it.
            if (keepsInherited(message) && draft.replaceAttachments && Option.isSome(original)) {
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
            if (uploaded) {
              yield* syncUploadedAttachments(account.id, id, message, true, true);
              if (changeKey) yield* captureVersion(yield* readDraftVersion(account.id, id));
              return id;
            }
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
        if (
          known &&
          (draft.remote?.changeKey || attachmentProofs.has(draftKey(account.id, known)))
        ) {
          const live = yield* readDraftVersion(account.id, known).pipe(
            Effect.map(Option.some),
            Effect.catchIf(is404, () => Effect.succeed(Option.none())),
          );
          conflict =
            draft.remote?.changeKey !== undefined &&
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
            Effect.tap(() =>
              Effect.sync(() => {
                attachmentProofs.delete(draftKey(account.id, id));
                draftVersions.delete(draftKey(account.id, id));
              }),
            ),
          );
        const id = remote.messageId ?? remote.draftId;
        if (id) {
          yield* remove(id);
          return;
        }
        if (!remote.rfcMessageId) return;
        const found = yield* draftLookup(account.id, remote.rfcMessageId);
        for (const draft of found.value) yield* remove(draft.id);
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

function fileAttachment(a: OutgoingMessage["attachments"][number]) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.mimeType,
    contentBytes: a.content,
    ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
  };
}

const recipients = (list: readonly Address[]) =>
  list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));

/** Custom internet headers are create-only; this property also supports draft updates. */
export const MARKDOWN_DRAFT_PROPERTY =
  "String {57d14d35-4d11-4f8f-ae63-961883378d87} Name OpenmailMarkdownSource";

function graphFields(message: OutgoingMessage) {
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

const draftKey = (accountId: string, id: string) => `${accountId}\0${id}`;
const keepsInherited = (message: OutgoingMessage) =>
  message.mode === "forward" && message.includeOriginalAttachments === undefined;
function needsUpload(message: OutgoingMessage, fields?: object) {
  if (message.attachments.some(largeAttachment)) return true;
  const graphMessage = {
    ...(fields ?? graphFields(message)),
    attachments: message.attachments.map(fileAttachment),
  };
  return (
    Buffer.byteLength(
      JSON.stringify(fields ? graphMessage : { message: graphMessage, saveToSentItems: true }),
    ) > REQUEST_LIMIT
  );
}

const checkRequestSize = (body: string) =>
  Buffer.byteLength(body) > REQUEST_LIMIT
    ? Effect.fail(
        new PermanentError({
          message:
            "Outlook message requests cannot exceed 4 MB. Large attached messages cannot be uploaded as Outlook items.",
        }),
      )
    : Effect.void;

const forwardsMessage = (message: OutgoingMessage) =>
  message.attachments.some((a) => a.mimeType.toLowerCase() === "message/rfc822");

const checkAttachmentSize = (message: OutgoingMessage) => {
  const problem = attachmentProblem("outlook", message.attachments, message);
  return problem
    ? Effect.fail(new PermanentError({ message: attachmentProblemMessage(problem) }))
    : Effect.void;
};
