import type { OutgoingAttachment, Provider } from "./domain.js";

// https://support.google.com/mail/answer/6590
const GMAIL_BLOCKED = new Set(
  "ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpkg dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll".split(
    " ",
  ),
);
const EXECUTABLE_MIME = new Set([
  "application/x-msdownload",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-sharedlib",
  "application/java-archive",
  "application/javascript",
  "text/javascript",
]);

export function attachmentBytes(content: string): number {
  const base64 = content.replace(/\s/g, "");
  return (
    Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0)
  );
}

export const GMAIL_MIME_LIMIT = 25 * 1024 * 1024;
export const COMPOSE_BODY_MARGIN = 256 * 1024;
export function encodedAttachmentBytes(bytes: number): number {
  const encoded = Math.ceil(bytes / 3) * 4;
  return encoded + Math.ceil(encoded / 76) * 2;
}

export type AttachmentProblem =
  | { kind: "gmailSize" }
  | { kind: "gmailBlocked"; filename: string }
  | { kind: "outlookSize" };

/** Shared by composer preflight and the core send boundary. SMTP checks the encoded MIME size. */
export function attachmentProblem(
  provider: Provider,
  attachments: readonly OutgoingAttachment[],
): AttachmentProblem | undefined {
  return attachmentSizesProblem(
    provider,
    attachments.map((file) => ({
      ...file,
      size: attachmentBytes(file.content),
    })),
  );
}

export function attachmentSizesProblem(
  provider: Provider,
  attachments: readonly { filename: string; mimeType: string; size: number }[],
): AttachmentProblem | undefined {
  const bytes = attachments.reduce((sum, file) => sum + file.size, 0);
  if (provider === "gmail") {
    for (const file of attachments) {
      const filename = file.filename
        .trim()
        .toLowerCase()
        .replace(/(?:\.(?:gz|bz2|xz|z))+$/i, "");
      if (
        GMAIL_BLOCKED.has(filename.split(".").at(-1) ?? "") ||
        EXECUTABLE_MIME.has(file.mimeType.toLowerCase().split(";")[0] ?? "")
      )
        return { kind: "gmailBlocked", filename: file.filename };
    }
    if (
      attachments.reduce(
        (sum, file) => sum + encodedAttachmentBytes(file.size),
        COMPOSE_BODY_MARGIN,
      ) > GMAIL_MIME_LIMIT
    )
      return { kind: "gmailSize" };
  }
  // Large attachment upload sessions are not implemented by this adapter.
  if (provider === "outlook" && bytes > 3 * 1024 * 1024) return { kind: "outlookSize" };
  return undefined;
}

export function attachmentProblemMessage(problem: AttachmentProblem): string {
  switch (problem.kind) {
    case "gmailSize":
      return "Gmail attachments exceed 25 MB in total. Remove attachments before sending.";
    case "gmailBlocked":
      return `Gmail blocks ${problem.filename}. Remove this attachment before sending.`;
    case "outlookSize":
      return "This app supports Outlook attachments up to 3 MB in total. Large attachment uploads are not supported yet. Remove attachments before sending.";
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

/** Moving by index keeps duplicate filenames distinct and preserves CID identifiers. */
export function reorderAttachments<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const result = [...items];
  const moved = result.splice(from, 1);
  result.splice(to, 0, ...moved);
  return result;
}
