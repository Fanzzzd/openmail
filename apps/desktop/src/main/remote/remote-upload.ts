import type { IncomingMessage } from "node:http";
import {
  attachmentFilename,
  attachmentSizesProblem,
  COMPOSE_ATTACHMENT_LIMIT,
  type OutgoingAttachment,
  type Provider,
} from "@openmail/core/schema";

/** Multipart overhead allowed on top of the compose limit. */
export const UPLOAD_SLACK = 1024 * 1024;
const MAX_UPLOAD_FILES = 64;
/** Uploads read at once; each holds up to the compose limit in memory. */
export const MAX_CONCURRENT_UPLOADS = 2;

export type UploadResult =
  | { ok: true; files: OutgoingAttachment[] }
  | { ok: false; status: number; error: string; filename?: string };

const refused = (status: number, error: string): UploadResult => ({ ok: false, status, error });

/**
 * Reads the request body into one buffer of its declared length. Browsers send
 * Content-Length for FormData, so a missing one is refused instead of buffered
 * chunk by chunk.
 */
export async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | UploadResult> {
  const declared = Number(request.headers["content-length"]);
  if (!Number.isSafeInteger(declared) || declared <= 0) return refused(411, "invalid");
  if (declared > limit) return refused(413, "tooLarge");
  const body = new Uint8Array(declared);
  let size = 0;
  for await (const chunk of request) {
    const bytes: Uint8Array =
      chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
    if (size + bytes.byteLength > declared) return refused(400, "invalid");
    body.set(bytes, size);
    size += bytes.byteLength;
  }
  return size === declared ? body : refused(400, "invalid");
}

async function parseFiles(body: Uint8Array<ArrayBuffer>, contentType: string) {
  try {
    const form = await new Request("http://upload.invalid/", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();
    return {
      files: form.getAll("file").flatMap((entry) => (typeof entry === "string" ? [] : [entry])),
      existing: Number(form.get("existingBytes") ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Checks uploaded compose attachments with the desktop limits: 30 MB in total
 * and the account's blocked types and sizes. Returns base64 attachments.
 */
export async function readUpload(
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
  provider: Provider,
): Promise<UploadResult> {
  const parsed = await parseFiles(body, contentType);
  if (!parsed || parsed.files.length === 0 || parsed.files.length > MAX_UPLOAD_FILES)
    return refused(400, "invalid");
  const { files, existing } = parsed;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isFinite(existing) || existing < 0 || total + existing > COMPOSE_ATTACHMENT_LIMIT)
    return refused(413, "tooLarge");
  const described = files.map((file) => ({
    filename: attachmentFilename(file.name || "attachment"),
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  }));
  const problem = attachmentSizesProblem(provider, described);
  if (problem)
    return problem.kind === "gmailBlocked"
      ? { ok: false, status: 415, error: problem.kind, filename: problem.filename }
      : refused(413, problem.kind);
  const out: OutgoingAttachment[] = [];
  for (const [index, file] of files.entries()) {
    const info = described[index];
    if (!info) continue;
    out.push({
      filename: info.filename,
      mimeType: info.mimeType,
      // A view over the file's bytes, encoded once.
      content: Buffer.from(await file.arrayBuffer()).toString("base64"),
    });
  }
  return { ok: true, files: out };
}
