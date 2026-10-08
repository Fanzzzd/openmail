import type { DockFileReason } from "../shared/dock-files";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { COMPOSE_ATTACHMENT_LIMIT, type OutgoingAttachment } from "@openmail/core";

class DockFileError extends Error {
  constructor(readonly reason: DockFileReason) {
    super(reason);
  }
}
export const dockFileReason = (error: unknown): DockFileReason =>
  error instanceof DockFileError ? error.reason : "unreadable";

/** Open handles and bounded reads prevent directory drops and growing-file races. */
export async function readDockFiles(paths: readonly string[]): Promise<OutgoingAttachment[]> {
  try {
    if (paths.length > 256) throw new DockFileError("tooMany");
    const attachments: OutgoingAttachment[] = [];
    let total = 0;
    for (const filename of paths) {
      const file = await open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new DockFileError("notFile");
        const remaining = COMPOSE_ATTACHMENT_LIMIT - total;
        if (info.size > remaining) throw new DockFileError("tooLarge");
        const buffer = Buffer.alloc(Math.min(remaining + 1, info.size + 1));
        let length = 0;
        while (length < buffer.length) {
          const chunk = await file.read(buffer, length, buffer.length - length, null);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        // A file that grows after stat is rejected; no unbounded allocation occurs.
        if (length > info.size || total + length > COMPOSE_ATTACHMENT_LIMIT)
          throw new DockFileError("changed");
        total += length;
        const ext = path.extname(filename).toLowerCase();
        const types: Readonly<Record<string, string>> = {
          ".pdf": "application/pdf",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".txt": "text/plain",
          ".eml": "message/rfc822",
          ".csv": "text/csv",
        };
        attachments.push({
          filename: path.basename(filename),
          mimeType: types[ext] ?? "application/octet-stream",
          content: buffer.subarray(0, length).toString("base64"),
        });
      } finally {
        await file.close();
      }
    }
    return attachments;
  } catch (error) {
    throw new DockFileError(dockFileReason(error));
  }
}
