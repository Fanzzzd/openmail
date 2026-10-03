import { Schema } from "effect";

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
