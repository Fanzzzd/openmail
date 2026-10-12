import { COMPOSE_ATTACHMENT_LIMIT, DeviceError, type OutgoingAttachment } from "@openmail/core";
import { Effect } from "effect";
import { clipboard } from "electron";
import { RASTER_IMAGE } from "../../shared/native-compose";

type ClipboardEntry = {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob | { title: string; url: string }>;
};

/** Native image bytes only. Files come from File objects in the actual paste event.
 * A text/uri-list is untrusted text and never grants access to local paths. */
export async function readClipboardAttachments(
  items: readonly ClipboardEntry[],
): Promise<OutgoingAttachment[]> {
  const images: OutgoingAttachment[] = [];
  let total = 0;
  for (const item of items) {
    const mimeType = item.types.find((type) => RASTER_IMAGE.test(type));
    if (!mimeType) continue;
    const payload = await item.getType(mimeType);
    if (!(payload instanceof Blob)) continue;
    total += payload.size;
    if (total > COMPOSE_ATTACHMENT_LIMIT) throw new Error("Clipboard image exceeds 30 MB.");
    images.push({
      filename: `clipboard-${images.length + 1}.${mimeType.slice(6)}`,
      mimeType,
      content: Buffer.from(await payload.arrayBuffer()).toString("base64"),
    });
  }
  return images;
}

/** No filesystem reads, even if the native clipboard contains file URLs. */
export const clipboardAttachments = () =>
  Effect.tryPromise({
    try: async () => readClipboardAttachments(await clipboard.read()),
    catch: (error) =>
      new DeviceError({ message: error instanceof Error ? error.message : String(error) }),
  });
