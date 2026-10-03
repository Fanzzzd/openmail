import { attachmentFilename } from "@openmail/core/portable";
import { Directory, File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { Platform } from "react-native";
import * as Sharing from "expo-sharing";

export const SHARE_CACHE_BYTES = 64 * 1024 * 1024;
export const SHARE_CACHE_AGE = 24 * 60 * 60 * 1000;
const active = new Set<string>();
const rootDirectory = () => new Directory(Paths.cache, "openmail-share");
/** Android returns when handing the URI off; the receiving app may read it later. */
export function evictShareCopies(now = Date.now()) {
  const root = rootDirectory();
  if (!root.exists) return;
  const entries = root
    .list()
    .flatMap((entry) => {
      if (!(entry instanceof Directory)) return [];
      const files = entry.list().filter((file): file is File => file instanceof File);
      return [
        {
          directory: entry,
          bytes: files.reduce((sum, file) => sum + file.size, 0),
          used: Math.max(0, ...files.map((file) => file.modificationTime ?? 0)),
        },
      ];
    })
    .toSorted((a, b) => a.used - b.used || a.directory.uri.localeCompare(b.directory.uri));
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of entries) {
    if (active.has(entry.directory.uri)) continue;
    if (bytes <= SHARE_CACHE_BYTES && entry.used > now - SHARE_CACHE_AGE) continue;
    entry.directory.delete();
    bytes -= entry.bytes;
  }
}
/** Preserve recent Android handoffs across restart, evict by age and total bytes. */
export function clearShareCopies() {
  if (Platform.OS === "android") evictShareCopies();
  else {
    const root = rootDirectory();
    if (root.exists) root.delete();
  }
}
export async function shareReceivedAttachment(content: {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is unavailable");
  if (content.data.byteLength > SHARE_CACHE_BYTES)
    throw new Error("Share copy exceeds cache limit");
  evictShareCopies();
  const directory = new Directory(rootDirectory(), randomUUID());
  directory.create({ intermediates: true, idempotent: true });
  active.add(directory.uri);
  let handedOff = false;
  try {
    const leaf = content.filename.split(/[\\/]/).at(-1) ?? "";
    const filename =
      attachmentFilename(leaf)
        .replace(/[:%]/g, "_")
        .replace(/^[. ]+|[. ]+$/g, "") || "attachment";
    const file = new File(directory, filename);
    file.write(content.data);
    await Sharing.shareAsync(file.uri, { mimeType: content.mimeType });
    handedOff = true;
  } finally {
    active.delete(directory.uri);
    if (Platform.OS !== "android" || !handedOff) {
      if (directory.exists) directory.delete();
    }
    evictShareCopies();
  }
}
