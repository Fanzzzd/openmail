import { ApiError } from "./provider-http.js";
import { retryAfterMillis } from "./provider-retry.js";
import { Clock, Effect, Schema } from "effect";

export const BatchResponse = Schema.Struct({
  responses: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Number,
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});

/** Parse Gmail's multipart HTTP responses at the transport boundary. */
export function parseGmailBatch(text: string, contentType: string | undefined): unknown {
  const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
  if (!boundary) throw new Error("Missing Gmail batch boundary");
  const responses = text.split(`--${boundary}`).flatMap((part) => {
    if (!part.includes("HTTP/1.1")) return [];
    const id = /Content-ID:\s*<?(?:response-)?([^>\r\n]+)>?/i.exec(part)?.[1];
    const match = /HTTP\/1\.1 (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)/.exec(part);
    if (!id || !match) throw new Error("Invalid Gmail batch part");
    const headers = Object.fromEntries(
      (match[2] ?? "").split(/\r?\n/).flatMap((line) => {
        const colon = line.indexOf(":");
        return colon < 0
          ? []
          : [[line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]];
      }),
    );
    const raw = match[3]?.trim();
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    return [{ id, status: Number(match[1]), headers, ...(body === undefined ? {} : { body }) }];
  });
  return { responses };
}

/** Largest throttle deadline in a batch, or undefined when no response is throttled. */
function batchThrottleDelay(
  responses: typeof BatchResponse.Type.responses,
  now: number,
): number | undefined {
  const throttled = responses.filter(
    (response) => response.status === 429 || response.status >= 500,
  );
  return throttled.length
    ? Math.max(
        ...throttled.map((response) =>
          retryAfterMillis(
            response.headers?.["Retry-After"] ?? response.headers?.["retry-after"],
            now,
          ),
        ),
      )
    : undefined;
}

/** Stop after an exhausted chunk so the remaining candidates stay deferred. */
export const verifyInChunks = <A, B, E, R>(
  candidates: readonly A[],
  verify: (chunk: readonly A[]) => Effect.Effect<readonly B[], E, R>,
) =>
  Effect.gen(function* () {
    const results: B[] = [];
    for (let offset = 0; offset < candidates.length; offset += 20) {
      const verified = yield* verify(candidates.slice(offset, offset + 20)).pipe(Effect.result);
      if (verified._tag === "Failure") break;
      results.push(...verified.success);
    }
    return results;
  });

/** Turn batch throttles into the same retryable error, preserving the caller's label. */
export const deferIfThrottled = (
  responses: typeof BatchResponse.Type.responses,
  label: string,
  defer?: (delayMs: number) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const delay = batchThrottleDelay(responses, yield* Clock.currentTimeMillis);
    if (delay === undefined) return;
    if (defer) yield* defer(delay);
    yield* new ApiError({ status: 429, body: label, retryAfter: String(delay / 1000) });
  });
