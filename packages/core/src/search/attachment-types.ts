import type { Attachment, AttachmentType } from "../domain/message.js";

/** MIME and filename fallbacks share one definition for fetched mail and SQLite. */
export const ATTACHMENT_TYPES = {
  pdf: { mimeTypes: ["application/pdf"], extensions: ["pdf"] },
  image: {
    mimeTypes: [],
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "heic",
      "heif",
      "tif",
      "tiff",
      "bmp",
      "svg",
      "avif",
    ],
  },
  document: {
    mimeTypes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.oasis.opendocument.text",
      "application/rtf",
      "text/rtf",
      "text/plain",
    ],
    extensions: ["doc", "docx", "odt", "rtf", "txt"],
  },
  spreadsheet: {
    mimeTypes: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.spreadsheet",
      "text/csv",
    ],
    extensions: ["xls", "xlsx", "ods", "csv", "tsv"],
  },
  presentation: {
    mimeTypes: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.presentation",
    ],
    extensions: ["ppt", "pptx", "odp", "key"],
  },
} satisfies Record<AttachmentType, { mimeTypes: string[]; extensions: string[] }>;

export const isAttachmentType = (value: string): value is AttachmentType =>
  Object.hasOwn(ATTACHMENT_TYPES, value);
export function attachmentHasType(
  attachment: Pick<Attachment, "filename" | "mimeType">,
  type: AttachmentType,
): boolean {
  const spec = ATTACHMENT_TYPES[type];
  const mime = attachment.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    (type === "image" && mime.startsWith("image/")) ||
    spec.mimeTypes.some((value) => value === mime) ||
    spec.extensions.includes(/\.([^.]+)$/.exec(attachment.filename)?.[1]?.toLowerCase() ?? "")
  );
}
