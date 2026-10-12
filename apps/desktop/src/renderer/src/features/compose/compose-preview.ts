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
