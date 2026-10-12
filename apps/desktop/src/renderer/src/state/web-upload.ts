import { attachmentBytes, type OutgoingAttachment } from "@openmail/core/schema";

export type UploadResult =
  | { ok: true; files: OutgoingAttachment[] }
  | { ok: false; error: "tooLarge" | "gmailBlocked" | "failed"; filename?: string };

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
    // IO boundary: the Mac's JSON reply.
    const body = (await response.json()) as {
      files?: OutgoingAttachment[];
      error?: string;
      filename?: string;
    };
    if (response.ok && Array.isArray(body.files)) return { ok: true, files: body.files };
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
