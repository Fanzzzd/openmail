import { Effect, Option, Schema } from "effect";
import { attachmentBytes } from "../../mime/attachment-policy.js";
import type { OutgoingMessage } from "../../domain/changes.js";
import { ProviderError } from "../../domain/errors.js";
import { PlatformCrypto } from "../../platform/crypto.js";
import { graphPages } from "../provider-pages.js";
import { uncertainWrite } from "../provider-retry.js";
import { deliverOrConfirm } from "../provider-send.js";
import { attachmentRange, largeAttachment, makeAttachmentUpload } from "./upload.js";
import type { OutlookClient } from "./client.js";
import { AttachmentIds, DraftVersion, nextPage, UploadedAttachments, WithId } from "./graph.js";
import { draftKey, fileAttachment, keepsInherited } from "./graph-message.js";

/**
 * Draft state the send and draft paths share: the last draft version openmail
 * wrote, attachment fingerprints proven on the server, delivery and draft
 * lookups by Message-ID, and attachment upload and sync.
 */
export const makeOutlookDraftState = (client: OutlookClient) =>
  Effect.gen(function* () {
    const { get } = client;

    const crypto = yield* PlatformCrypto;
    const uploadAttachment = yield* makeAttachmentUpload(client);

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

    return {
      crypto,
      write,
      attachmentProofs,
      draftVersions,
      recordVersion,
      readDraftVersion,
      deleteInheritedAttachments,
      deliveryLookup,
      draftLookup,
      listDraftAttachments,
      addDraftAttachments,
      deliver,
      findMissing,
      deleteStale,
      syncUploadedAttachments,
    };
  });
export type OutlookDraftState = Effect.Success<ReturnType<typeof makeOutlookDraftState>>;
