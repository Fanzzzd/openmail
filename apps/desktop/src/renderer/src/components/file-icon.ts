import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Mail,
} from "lucide-react";
import { createElement, type ComponentType } from "react";

type Icon = ComponentType<{ className?: string }>;

export function iconFor(mimeType: string, filename: string): Icon {
  const type = mimeType.toLowerCase();
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  // Downloads know only the file name, so the extension stands in for the type.
  if (type.startsWith("image/") || /^(png|jpe?g|gif|heic|webp|tiff?|bmp)$/.test(ext))
    return FileImage;
  if (type.startsWith("audio/") || /^(mp3|m4a|wav|aac|flac)$/.test(ext)) return FileAudio;
  if (type.startsWith("video/") || /^(mp4|mov|m4v|webm)$/.test(ext)) return FileVideo;
  if (type === "message/rfc822" || ext === "eml") return Mail;
  if (/zip|compressed|tar|gzip|x-7z|rar/.test(type) || /^(zip|rar|7z|gz|tgz|tar)$/.test(ext))
    return FileArchive;
  if (/spreadsheet|excel|csv/.test(type) || /^(xlsx?|csv|numbers)$/.test(ext))
    return FileSpreadsheet;
  if (
    type.startsWith("text/") ||
    /pdf|word|document|presentation/.test(type) ||
    /^(pdf|docx?|pptx?|key|pages|txt|rtf|md)$/.test(ext)
  )
    return FileText;
  return File;
}

/** The type icon for a file, as a component so callers do not pick one during render. */
export function FileIcon({
  mimeType = "",
  filename,
  className,
}: {
  mimeType?: string;
  filename: string;
  className?: string;
}) {
  return createElement(iconFor(mimeType, filename), { className });
}
