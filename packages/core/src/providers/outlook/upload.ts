import { Clock, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { attachmentBytes, OUTLOOK_ATTACHMENT_THRESHOLD } from "../../attachment-policy.js";
import type { OutgoingAttachment } from "../../domain/domain.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../../domain/errors.js";
import { Buffer } from "../../platform/bytes.js";
import { ApiError, transferAllowance } from "../provider-http.js";
import { retryAfterMillis } from "../provider-retry.js";
import type { OutlookClient } from "./client.js";
import { decode } from "./graph.js";

export const OUTLOOK_UPLOAD_LIMIT = 150 * 1024 * 1024;
export const UPLOAD_BLOCK_SIZE = 320 * 1024;
// Also divisible by three, so normal chunks align with base64 quartets.
export const UPLOAD_CHUNK_SIZE = 9 * UPLOAD_BLOCK_SIZE;
const MAX_SESSION_RESTARTS = 2;
const MAX_CHUNK_FAILURES = 4;
export const uploadTimeout = (bytes: number) => 30000 + transferAllowance(bytes);
const uploadFailed = "Outlook attachment upload failed. Try saving or sending again.";
const uploadFailureBody = JSON.stringify({ error: { message: uploadFailed } });
const invalidSession = new ProviderError({ message: "Invalid Outlook upload session" });
const SessionError = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });

const UploadSession = Schema.Struct({
  uploadUrl: Schema.String,
  expirationDateTime: Schema.String,
  nextExpectedRanges: Schema.Array(Schema.String),
});
const UploadProgress = Schema.Union([
  Schema.Struct({ nextExpectedRanges: Schema.Array(Schema.String) }),
  Schema.Struct({ NextExpectedRanges: Schema.Array(Schema.String) }),
]);
// Outlook's upload endpoint uses both casings; Graph's session creation uses camelCase.
const decodeProgress = (json: unknown) =>
  decode(UploadProgress)(json).pipe(
    Effect.mapError(() => new ProviderError({ message: "Invalid Outlook upload response" })),
    Effect.map((progress) => ({
      nextExpectedRanges:
        "nextExpectedRanges" in progress
          ? progress.nextExpectedRanges
          : progress.NextExpectedRanges,
    })),
  );

/** Decode only this range. The compose model already owns the base64 source. */
export function attachmentRange(content: string, start: number, length: number): Uint8Array {
  const first = Math.floor(start / 3) * 4;
  const last = Math.ceil((start + length) / 3) * 4;
  return Buffer.from(content.slice(first, last), "base64").subarray(
    start % 3,
    (start % 3) + length,
  );
}

export const largeAttachment = (file: OutgoingAttachment) =>
  attachmentBytes(file.content) >= OUTLOOK_ATTACHMENT_THRESHOLD;

const expectedRange = (ranges: readonly string[], size: number) =>
  Effect.try({
    try: () => {
      const parsed = ranges
        .map((range) => {
          const match = /^(\d+)(?:-(\d*))?$/.exec(range);
          if (!match) throw new Error();
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) + 1 : size;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start >= end ||
            end > size
          )
            throw new Error();
          return { start, end };
        })
        .toSorted((a, b) => a.start - b.start);
      const first = parsed[0];
      if (!first) throw new Error();
      return first;
    },
    catch: () => new ProviderError({ message: "Invalid Outlook upload byte ranges" }),
  });

/** Upload URLs carry credentials. Neither errors nor diagnostics include them or file bytes. */
export const makeAttachmentUpload = (client: OutlookClient) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const request = (req: HttpClientRequest.HttpClientRequest, timeout = 30000) =>
      http.execute(HttpClientRequest.removeHeader(req, "authorization")).pipe(
        Effect.timeout(timeout),
        Effect.mapError(() => new ApiError({ status: 0, body: uploadFailureBody })),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status >= 200 && response.status < 300) return response;
            const json = yield* response.json.pipe(Effect.option);
            const decoded = Option.isSome(json)
              ? Schema.decodeUnknownOption(SessionError)(json.value)
              : Option.none();
            const expired =
              Option.isSome(decoded) &&
              /session.*expired|expired.*session/i.test(decoded.value.error.code);
            return yield* new ApiError({
              status: expired ? 410 : response.status,
              body: uploadFailureBody,
              ...(response.headers["retry-after"]
                ? { retryAfter: response.headers["retry-after"] }
                : {}),
            });
          }),
        ),
      );
    const progress = (url: string) =>
      request(HttpClientRequest.get(url)).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.mapError(
              () => new ProviderError({ message: "Could not read Outlook upload progress" }),
            ),
            Effect.flatMap(decodeProgress),
          ),
        ),
      );

    return (
      accountId: string,
      id: string,
      file: OutgoingAttachment,
      exists: () => Effect.Effect<boolean, ApiError | ProviderFailure>,
    ) =>
      Effect.gen(function* () {
        const size = attachmentBytes(file.content);
        if (size > OUTLOOK_UPLOAD_LIMIT)
          yield* new PermanentError({ message: "Outlook file attachments cannot exceed 150 MB" });
        let failures = 0;
        let waited = 0;
        const uploadOnce = (session: typeof UploadSession.Type) =>
          Effect.gen(function* () {
            let ranges = session.nextExpectedRanges;
            for (;;) {
              const range = yield* expectedRange(ranges, size);
              const length = Math.min(UPLOAD_CHUNK_SIZE, range.end - range.start);
              const result = yield* Effect.gen(function* () {
                const response = yield* request(
                  HttpClientRequest.put(session.uploadUrl).pipe(
                    HttpClientRequest.bodyUint8Array(
                      attachmentRange(file.content, range.start, length),
                      "application/octet-stream",
                    ),
                    HttpClientRequest.setHeader("content-length", String(length)),
                    HttpClientRequest.setHeader(
                      "content-range",
                      `bytes ${range.start}-${range.start + length - 1}/${size}`,
                    ),
                  ),
                  uploadTimeout(length),
                );
                if (response.status === 201) return null;
                return yield* response.json.pipe(
                  Effect.mapError(
                    () => new ProviderError({ message: "Invalid Outlook upload response" }),
                  ),
                  Effect.flatMap(decodeProgress),
                );
              }).pipe(Effect.result);
              if (result._tag === "Success") {
                if (result.success === null) return true;
                const next = yield* expectedRange(result.success.nextExpectedRanges, size);
                if (next.start <= range.start)
                  return yield* new ProviderError({
                    message: "Outlook attachment upload made no progress",
                  });
                ranges = result.success.nextExpectedRanges;
                continue;
              }
              const error = result.failure;
              if (!(error instanceof ApiError)) return yield* Effect.fail(error);
              if (error.status === 401 || error.status === 404 || error.status === 410)
                return yield* exists();
              if (
                (error.status !== 0 &&
                  error.status !== 416 &&
                  error.status !== 429 &&
                  error.status < 500) ||
                ++failures > MAX_CHUNK_FAILURES
              )
                return yield* Effect.fail(error);
              const delay = retryAfterMillis(error.retryAfter, yield* Clock.currentTimeMillis);
              if (waited + delay > 60000) return yield* Effect.fail(error);
              if (delay) {
                waited += delay;
                yield* Effect.sleep(delay);
              }
              const status = yield* progress(session.uploadUrl).pipe(Effect.result);
              if (status._tag === "Failure") return yield* exists();
              ranges = status.success.nextExpectedRanges;
            }
          });
        for (let restart = 0; restart <= MAX_SESSION_RESTARTS; restart++) {
          const session = yield* client
            .write(
              accountId,
              "POST",
              `/me/messages/${encodeURIComponent(id)}/attachments/createUploadSession`,
              {
                AttachmentItem: {
                  attachmentType: "file",
                  name: file.filename,
                  size,
                  contentType: file.mimeType,
                  ...(file.contentId ? { isInline: true, contentId: file.contentId } : {}),
                },
              },
            )
            .pipe(
              Effect.flatMap((json) =>
                decode(UploadSession)(json).pipe(Effect.mapError(() => invalidSession)),
              ),
            );
          const valid = yield* Effect.try({
            try: () => {
              const url = new URL(session.uploadUrl);
              return (
                url.protocol === "https:" &&
                url.hostname === "outlook.office.com" &&
                !url.username &&
                !url.password &&
                !url.port &&
                Number.isFinite(Date.parse(session.expirationDateTime))
              );
            },
            catch: () => invalidSession,
          });
          if (!valid) yield* invalidSession;
          const complete = yield* uploadOnce(session).pipe(
            Effect.onExit((exit) =>
              exit._tag === "Success" && exit.value
                ? Effect.void
                : request(HttpClientRequest.delete(session.uploadUrl), 5000).pipe(
                    Effect.catch(() => Effect.void),
                  ),
            ),
          );
          if (complete) return;
        }
        yield* new ProviderError({
          message: "Outlook attachment upload session expired repeatedly",
        });
      });
  });
