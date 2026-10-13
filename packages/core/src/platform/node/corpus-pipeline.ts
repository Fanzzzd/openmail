import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Option, Schema } from "effect";
import { Attachment, Message, Provider, type IncomingMessage } from "../../domain/domain.js";
import { htmlToText } from "../../mime.js";
import { modelContext } from "../../model-view.js";
import { prepareMessageHtml } from "../../reader-html.js";
import { sanitizeReaderHtml } from "../../reader-sanitize.js";
import { createVisibleTextTrace, inspectHtmlStructure } from "../../visible-text-diagnostics.js";
import { visibleHtmlText } from "../../visible-text.js";
import { linkDisplayMismatch } from "../../link-security.js";
import { messageSecurity } from "../../message-security.js";
import { structuredMailEvents } from "../../structured-events.js";
import { normalizeMimeCharsets, withDecodedBody } from "../mime-compat.js";
import { nodeMailCodec } from "./mail-codec.js";
import {
  emptyAnomalies,
  type CorpusAnomaly,
  CorpusMimeType,
  type CorpusStage,
  type ExceptionClass,
  type WorkerEvent,
} from "./corpus-report.js";

const Headers = Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }));
const CacheRow = Schema.Struct({
  id: Schema.String,
  account_id: Schema.String,
  thread_id: Schema.String,
  provider_id: Schema.String,
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  to_json: Schema.fromJsonString(Schema.Array(Message.fields.from)),
  cc_json: Schema.fromJsonString(Schema.Array(Message.fields.from)),
  date: Schema.Number,
  body_text: Schema.String,
  body_html: Schema.String,
  attachments_json: Schema.fromJsonString(Schema.Array(Attachment)),
  headers_json: Schema.NullOr(Schema.fromJsonString(Headers)),
  rfc_message_id: Schema.NullOr(Schema.String),
  provider: Provider,
  authserv_id: Schema.NullOr(Schema.String),
});
function decodeCache(raw: unknown) {
  const row = Schema.decodeUnknownSync(CacheRow)(raw);
  const message: Message = {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    subject: row.subject,
    from: { name: row.from_name, address: row.from_addr },
    to: row.to_json,
    cc: row.cc_json,
    date: row.date,
    snippet: "",
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments: row.attachments_json,
    headers: row.headers_json ?? [],
    labels: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: row.attachments_json.length > 0,
    ...(row.rfc_message_id === null ? {} : { rfcMessageId: row.rfc_message_id }),
  };
  return { row, message };
}

const safeType = (value: string): CorpusMimeType =>
  Option.getOrNull(
    Schema.decodeUnknownOption(CorpusMimeType)(value.split(";", 1)[0]?.trim().toLowerCase()),
  ) ?? "other";
/** Cache-derived structure; header parameters and custom media types never reach output. */
function cachedStructure(row: {
  headers_json: string | null;
  body_text: string;
  body_html: string;
  attachments_json: string;
}) {
  const headers = Option.getOrNull(
    Schema.decodeUnknownOption(Schema.fromJsonString(Headers))(row.headers_json),
  );
  const attachments = Option.getOrNull(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Attachment)))(
      row.attachments_json,
    ),
  );
  const children: CorpusMimeType[] = [
    ...(row.body_text ? ["text/plain" as const] : []),
    ...(row.body_html ? ["text/html" as const] : []),
    ...(attachments ?? []).slice(0, 16).map((part) => safeType(part.mimeType)),
  ];
  const root = safeType(headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "");
  const inferred = children.length > 1 ? "multipart/mixed" : (children[0] ?? "other");
  if ((attachments?.length ?? 0) > 16) children.push("other");
  return { root: root === "other" ? inferred : root, parts: children };
}

const cachedMimePart = (type: string, body: string) =>
  `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString("base64")}\r\n`;

function cachedMime(message: Message): Uint8Array {
  // Cached strings have already been decoded. Never reapply their original charset.
  const headers = (message.headers ?? [])
    .filter(
      (h) =>
        ![
          "content-type",
          "content-transfer-encoding",
          "mime-version",
          "content-disposition",
        ].includes(h.name.toLowerCase()),
    )
    .filter((h) => /^[A-Za-z][A-Za-z0-9-]*$/.test(h.name))
    .map((h) => `${h.name}: ${h.value.replace(/\r?\n[ \t]+/g, " ").replace(/[\r\n]/g, " ")}`);
  const body = message.bodyHtml
    ? `Content-Type: multipart/alternative; boundary="openmail-corpus"\r\n\r\n--openmail-corpus\r\n${cachedMimePart("text/plain", message.bodyText)}--openmail-corpus\r\n${cachedMimePart("text/html", message.bodyHtml)}--openmail-corpus--\r\n`
    : cachedMimePart("text/plain", message.bodyText);
  return normalizeMimeCharsets(
    Buffer.from(
      `${headers.join("\r\n")}${headers.length ? "\r\n" : ""}MIME-Version: 1.0\r\n${body}`,
    ),
  );
}

export function corpusException(error: unknown): ExceptionClass {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof Error && error.name === "PermanentError") return "PermanentError";
  if (Schema.isSchemaError(error)) return "SchemaError";
  return "Error";
}

function tracedVisibleText(
  html: string,
  trace: ReturnType<typeof createVisibleTextTrace> | null,
  hits: Set<CorpusAnomaly>,
) {
  return visibleHtmlText(html, {
    diagnostic: (kind) => {
      hits.add(kind);
      trace?.diagnostic(kind);
    },
    observer: trace?.observer,
  });
}

/** SQLite's actual production tokenizers, with only a disposable in-memory index. */
export class CorpusPipeline {
  private readonly fts = new DatabaseSync(":memory:");
  constructor() {
    this.fts.exec(
      "CREATE VIRTUAL TABLE trigrams USING fts5(subject,body_text,tokenize='trigram'); CREATE VIRTUAL TABLE words USING fts5(subject,body_text,tokenize='unicode61')",
    );
  }
  close() {
    this.fts.close();
  }
  async run(raw: unknown, send: (event: WorkerEvent) => void, explain = false) {
    const measure = async <A>(
      stage: CorpusStage,
      action: (anomaly: (kind: CorpusAnomaly, count?: number) => void) => A | Promise<A>,
    ): Promise<A | undefined> => {
      send({ kind: "start", stage });
      const start = performance.now();
      const anomalies = emptyAnomalies();
      const anomaly = (kind: CorpusAnomaly, count = 1) => {
        anomalies[kind] += count;
      };
      let failure: ExceptionClass | null = null;
      let value: A | undefined;
      try {
        value = await action(anomaly);
      } catch (error) {
        failure = corpusException(error);
      }
      send({ kind: "stage", stage, ms: performance.now() - start, failure, anomalies });
      return value;
    };
    const decoded = await measure("cache-decode", () => {
      const metadata = Schema.decodeUnknownSync(
        Schema.Struct({
          headers_json: Schema.NullOr(Schema.String),
          body_text: Schema.String,
          body_html: Schema.String,
          attachments_json: Schema.String,
        }),
      )(raw);
      send({ kind: "structure", structure: cachedStructure(metadata) });
      return decodeCache(raw);
    });
    if (!decoded) return;
    const { row } = decoded;
    let message = decoded.message;
    await measure("mime-decode", async (anomaly) => {
      const parsed = await nodeMailCodec.parse(cachedMime(message), {
        skipHtmlToText: true,
        skipTextToHtml: true,
      });
      const incoming: IncomingMessage = { ...message, providerId: row.provider_id };
      const body = withDecodedBody(incoming, parsed);
      message = { ...message, ...body };
      const text = message.bodyText + message.bodyHtml;
      let replacements = 0,
        characters = 0;
      for (const character of text) {
        characters++;
        if (character === "\uFFFD") replacements++;
      }
      if (replacements / Math.max(1, characters) > 0.01) anomaly("charset-replacements");
    });
    let sanitized: string | undefined;
    await measure("reader-sanitize", (anomaly) => {
      if (Buffer.byteLength(message.bodyHtml) > 1024 * 1024) anomaly("oversized-html");
      sanitized = sanitizeReaderHtml(prepareMessageHtml(message.bodyHtml).html);
    });
    await measure("visible-text", (anomaly) => {
      const hits = new Set<CorpusAnomaly>();
      const originalTrace = explain
        ? createVisibleTextTrace(prepareMessageHtml(message.bodyHtml).html)
        : null;
      const sanitizedTrace =
        explain && sanitized !== undefined ? createVisibleTextTrace(sanitized) : null;
      const original = tracedVisibleText(message.bodyHtml, originalTrace, hits);
      const after =
        sanitized === undefined ? original : tracedVisibleText(sanitized, sanitizedTrace, hits);
      if (originalTrace && sanitizedTrace)
        send({
          kind: "explanation",
          diagnostics: {
            textPlainNonEmpty: decoded.message.bodyText.trim().length > 0,
            decodedTextPlainNonEmpty: message.bodyText.trim().length > 0,
            cachedHtml: inspectHtmlStructure(decoded.message.bodyHtml),
            original: originalTrace.finish(original),
            sanitized: sanitizedTrace.finish(after),
          },
        });
      for (const hit of hits) anomaly(hit);
      if ("flags" in original || "flags" in after) anomaly("budget-exceeded");
      if (original.text.length > 0 && after.text.length < original.text.length * 0.1)
        anomaly("sanitizer-text-loss");
      if (message.bodyHtml.trim() && !after.text.trim()) anomaly("empty-visible-text");
    });
    if (explain) return;
    await measure("model-text", (anomaly) => {
      const view = modelContext([message]);
      if (view.messages.some((m) => m.flags?.includes("budget-exceeded")))
        anomaly("budget-exceeded");
    });
    await measure("link-security", (anomaly) => {
      let mismatches = 0;
      // Use the same visible-text traversal, including ancestor and stylesheet rules.
      const visible = visibleHtmlText(sanitized ?? prepareMessageHtml(message.bodyHtml).html, {
        budgetFallback: "visible",
        linkObserver: (href, label) => {
          if (linkDisplayMismatch(href, label)) mismatches++;
        },
      });
      if ("flags" in visible) anomaly("budget-exceeded");
      else if (mismatches) anomaly("link-display-mismatch", mismatches);
    });
    await measure("message-security", (anomaly) => {
      messageSecurity(message.headers ?? [], row.provider, row.authserv_id);
      if (
        !message.rfcMessageId?.trim() &&
        !(message.headers ?? []).some(
          (h) => h.name.toLowerCase() === "message-id" && h.value.trim(),
        )
      )
        anomaly("missing-message-id");
      const dates = (message.headers ?? []).filter((h) => h.name.toLowerCase() === "date");
      if (
        !Number.isFinite(new Date(message.date).getTime()) ||
        dates.some((h) => !Number.isFinite(Date.parse(h.value)))
      )
        anomaly("failed-date-parse");
    });
    await measure("structured-events", (anomaly) => {
      const events = structuredMailEvents(message.bodyHtml, message.subject).events;
      if (events.length) anomaly("structured-events-found", events.length);
      if (message.bodyHtml.length > 1_000_000) anomaly("budget-exceeded");
    });
    await measure("snippet-plain-text", () => {
      const text = message.bodyText || htmlToText(message.bodyHtml);
      // The same cached-body/snippet constructor used by provider MIME fallback.
      withDecodedBody(
        { ...message, providerId: row.provider_id },
        {
          headers: new Map(),
          attachments: [],
          html: message.bodyHtml || false,
          text,
        },
      );
    });
    await measure("fts-tokenize", () => {
      for (const table of ["trigrams", "words"]) {
        this.fts.exec(`DELETE FROM ${table}`);
        this.fts
          .prepare(`INSERT INTO ${table}(subject,body_text) VALUES (?,?)`)
          .run(message.subject, message.bodyText);
        this.fts.exec(`DELETE FROM ${table}`);
      }
    });
  }
}
