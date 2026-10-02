import { Effect, type Cause } from "effect";
import type { OutgoingAttachment, Provider } from "../../shared/api";
import type { Draft } from "./draft";

export function inheritsOriginals(draft: Draft, provider: Provider | undefined): boolean {
  return (
    provider === "outlook" &&
    draft.mode === "forward" &&
    !draft.forwardAsAttachment &&
    draft.includeOriginalAttachments === undefined
  );
}

/** CID parts without a quoted image become ordinary attachments, rather than disappearing. */
export function withOriginalAttachments(draft: Draft, files: readonly OutgoingAttachment[]): Draft {
  const html = draft.body.kind === "rich" ? (draft.body.originalHtml ?? draft.body.html) : "";
  return {
    ...draft,
    loadOriginalAttachments: false,
    includeOriginalAttachments: true,
    attachments: [
      ...draft.attachments.filter((file) => file.sourceMessageId !== draft.inReplyTo),
      ...files.map((file) => {
        if (!file.contentId || html.includes(`cid:${file.contentId}`)) return file;
        const { contentId: _cid, ...regular } = file;
        return regular;
      }),
    ],
  };
}

/** Failure affects attachment loading only; the open composer and body edits survive. */
export function loadOriginalAttachments<A, E, R>(
  load: Effect.Effect<readonly OutgoingAttachment[], E, R>,
  loaded: (files: readonly OutgoingAttachment[]) => A,
  failed: (cause: Cause.Cause<E>) => A,
) {
  return load.pipe(Effect.matchCause({ onSuccess: loaded, onFailure: failed }));
}
