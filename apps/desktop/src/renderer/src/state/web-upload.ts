import { attachmentBytes, OutgoingAttachment } from "@openmail/core/schema";
import { Schema } from "effect";

export type UploadResult =
  | { ok: true; files: readonly OutgoingAttachment[] }
  | { ok: false; error: "tooLarge" | "gmailBlocked" | "failed"; filename?: string };

/** The Mac's JSON reply. Anything else reads as a failed upload. */
const UploadReply = Schema.Struct({
  files: Schema.optionalKey(Schema.Array(OutgoingAttachment)),
  error: Schema.optionalKey(Schema.String),
  filename: Schema.optionalKey(Schema.String),
});
const decodeReply = Schema.decodeUnknownOption(UploadReply);

/**
 * The web build's compose attachments go to the Mac's upload endpoint, which
 * applies the desktop limits again (30 MB in total, the provider's blocked
 * types) and returns them encoded for the draft.
 */
export async function uploadAttachments(
  files: Iterable<File>,
  accountId: string | undefined,
  existing: readonly OutgoingAttachment[],
): Promise<UploadResult> {
  const form = new FormData();
  for (const file of files) form.append("file", file, file.name);
  form.append(
    "existingBytes",
    String(existing.reduce((sum, file) => sum + attachmentBytes(file.content), 0)),
  );
  const query = accountId ? `?${new URLSearchParams({ account: accountId }).toString()}` : "";
  try {
    const response = await fetch(`/api/upload${query}`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    const reply = decodeReply(await response.json());
    const body = reply._tag === "Some" ? reply.value : {};
    if (response.ok && body.files) return { ok: true, files: body.files };
    if (body.error === "gmailBlocked")
      return {
        ok: false,
        error: "gmailBlocked",
        ...(body.filename ? { filename: body.filename } : {}),
      };
    return { ok: false, error: response.status === 413 ? "tooLarge" : "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}
