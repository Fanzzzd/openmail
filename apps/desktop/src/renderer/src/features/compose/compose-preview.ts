import {
  composeTransportHtml,
  preservedComposeHtml,
  prepareMessageHtml,
  composeCid,
  type ComposeBody,
} from "@openmail/core/schema";
import type { OutgoingAttachment } from "../../../../shared/api";
import { RASTER_IMAGE } from "../../../../shared/native-compose";

export function composePreviewHtml(
  body: Extract<ComposeBody, { kind: "rich" }>,
  attachments: readonly OutgoingAttachment[],
): string {
  const transport =
    composeTransportHtml({
      html: preservedComposeHtml(body.originalHtml ?? body.html),
      ...(body.font ? { composeFont: body.font } : {}),
    }) ?? "";
  const inline = Object.fromEntries(
    attachments.flatMap((file) => {
      const cid = file.contentId ? composeCid(`cid:${file.contentId}`)?.slice(4) : undefined;
      return cid && RASTER_IMAGE.test(file.mimeType)
        ? [[cid, `data:${file.mimeType};base64,${file.content}`]]
        : [];
    }),
  );
  return prepareMessageHtml(transport, { inline }).html;
}

/**
 * The read-only quoted original below the editor. Its HTML starts with the blank line that
 * separates the reply from "On … wrote:" in the sent message. Below the editor that line is only a
 * gap, so the preview starts at the attribution. The sent HTML keeps it.
 */
export function quotedOriginalPreviewHtml(
  quotedHtml: string,
  font: Extract<ComposeBody, { kind: "rich" }>["font"],
  attachments: readonly OutgoingAttachment[],
): string {
  return composePreviewHtml(
    {
      kind: "rich",
      text: "",
      html: quotedHtml.replace(/^(?:\s|<br\s*\/?>)+/i, ""),
      ...(font ? { font } : {}),
    },
    attachments,
  );
}
