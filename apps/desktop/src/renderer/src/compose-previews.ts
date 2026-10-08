import type { OutgoingAttachment } from "../../shared/api";
import { RASTER_IMAGE } from "../../shared/native-compose";

type ImagePart = OutgoingAttachment & { contentId: string };

export function makeInlinePreviewCache(
  create = (file: OutgoingAttachment) => {
    const bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  },
  revoke = (url: string) => URL.revokeObjectURL(url),
) {
  const entries = new Map<string, { file: ImagePart; url: string }>();
  let previous: readonly OutgoingAttachment[] | null = null;
  return {
    sync(files: readonly OutgoingAttachment[]) {
      if (files === previous) return;
      previous = files;
      const seen = new Set<string>();
      for (const file of files) {
        if (!file.contentId || !RASTER_IMAGE.test(file.mimeType)) continue;
        seen.add(file.contentId);
        const existing = entries.get(file.contentId);
        if (existing?.file.content === file.content && existing.file.mimeType === file.mimeType)
          continue;
        if (existing) revoke(existing.url);
        entries.set(file.contentId, {
          file: { ...file, contentId: file.contentId },
          url: create(file),
        });
      }
      for (const [cid, entry] of entries) {
        if (seen.has(cid)) continue;
        revoke(entry.url);
        entries.delete(cid);
      }
    },
    get(cid: string) {
      return entries.get(cid)?.url;
    },
    dispose() {
      for (const entry of entries.values()) revoke(entry.url);
      entries.clear();
      previous = null;
    },
  };
}
