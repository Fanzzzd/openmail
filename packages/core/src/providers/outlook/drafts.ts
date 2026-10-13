import { Effect, Option, Schema } from "effect";
import type { Account } from "../../domain/account.js";
import type { DraftRemote } from "../../domain/changes.js";
import { draftVersionMetadata } from "../../compose/draft-version.js";
import { ProviderError, type ProviderFailure } from "../../domain/errors.js";
import { MarkdownDraftSource, markdownDraftSource } from "../../compose/markdown-draft.js";
import { ApiError } from "../provider-http.js";
import { uncertainWrite } from "../provider-retry.js";
import type { DraftPush, DraftSaveResult } from "../adapter.js";
import type { OutlookClient } from "./client.js";
import { AttachmentIds, decode, DraftVersion, is404, writeFailure } from "./graph.js";
import type { OutlookDraftState } from "./draft-state.js";
import {
  keepsInherited,
  graphFields,
  fileAttachment,
  draftKey,
  checkAttachmentSize,
  MARKDOWN_DRAFT_PROPERTY,
  needsUpload,
} from "./graph-message.js";

/** Saving, deleting and reading back Outlook drafts. */
export const makeOutlookDrafts = (client: OutlookClient, draftState: OutlookDraftState) => {
  const { get } = client;
  const {
    write,
    attachmentProofs,
    draftVersions,
    readDraftVersion,
    deleteInheritedAttachments,
    draftLookup,
    addDraftAttachments,
    syncUploadedAttachments,
  } = draftState;

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
              (x.contentId !== null && x.contentId !== undefined && managedInline.has(x.contentId)),
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
      if (known && (draft.remote?.changeKey || attachmentProofs.has(draftKey(account.id, known)))) {
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

  return { saveDraft, deleteDraft, draftMarkdownSource };
};
