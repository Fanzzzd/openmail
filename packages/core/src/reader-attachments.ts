import { Effect, Result } from "effect";
import { simpleParser } from "mailparser";
import { InvalidInput, NotFound, ProviderError } from "./errors.js";
import type { AttachmentContent, AttachmentPartResult, Mailbox, PerformError } from "./mailbox.js";
import type { EmbeddedMessage, ReaderAttachment } from "./attachment-view.js";
import {
  decodeTnef,
  isEmbeddedMessage,
  isTnef,
  MAX_ATTACHMENT_CONTAINER_BYTES,
  MAX_CONTAINER_PARTS,
} from "./tnef.js";
import { prepareMessageHtml } from "./reader-html.js";
import { escapeComposeText, preservedComposeHtml } from "./compose-body.js";
import { attachmentFilename } from "./attachment-filename.js";

const descriptor = (
  part: { filename: string; mimeType: string; size: number },
  path: readonly number[],
  decodeError = false,
): ReaderAttachment => ({
  filename: attachmentFilename(part.filename),
  mimeType: part.mimeType,
  size: part.size,
  path,
  embedded: isEmbeddedMessage(part),
  decodeError,
});
const parseMessage = (part: AttachmentContent) =>
  Effect.tryPromise({
    try: async () => {
      if (!isEmbeddedMessage(part)) throw new Error("This attachment is not an RFC822 message");
      if (part.data.byteLength > MAX_ATTACHMENT_CONTAINER_BYTES)
        throw new Error("Embedded message exceeds 32 MB");
      const parsed = await simpleParser(
        Buffer.from(part.data.buffer, part.data.byteOffset, part.data.byteLength),
        {
          skipImageLinks: true,
          skipHtmlToText: true,
          skipTextToHtml: true,
          maxHtmlLengthToParse: MAX_ATTACHMENT_CONTAINER_BYTES,
        },
      );
      if (parsed.attachments.length > MAX_CONTAINER_PARTS)
        throw new Error("Too many embedded attachments");
      return parsed;
    },
    catch: (error) =>
      new ProviderError({ message: error instanceof Error ? error.message : String(error) }),
  });

/** One request owns one tree. Each root and decoded prefix is visited once.
 * The budget includes roots, all decoded ancestor contents, and returned copies. */
export function makeReaderAttachments(
  attachment: Mailbox["Service"]["attachment"],
  thread: (id: string) => Effect.Effect<import("./domain.js").Message[], NotFound>,
) {
  const openTree = Effect.fnUntraced(function* (messageId: string) {
    const message = (yield* thread(messageId)).find((m) => m.id === messageId);
    if (!message) return yield* new NotFound({ what: "message", id: messageId });
    let bytes = 0;
    const charge = (size: number) =>
      Effect.suspend(() => {
        if (bytes + size > MAX_ATTACHMENT_CONTAINER_BYTES)
          return Effect.fail(
            new InvalidInput({
              message: "Attachments and their containers exceed the 32 MB reader limit",
            }),
          );
        bytes += size;
        return Effect.void;
      });
    const nodes = new Map<string, Result.Result<AttachmentContent, PerformError>>();
    const containers = new Map<string, Result.Result<AttachmentContent[], PerformError>>();
    const messages = new Map<
      string,
      Result.Result<Effect.Success<ReturnType<typeof parseMessage>>, PerformError>
    >();
    const parsedMessage = Effect.fnUntraced(function* (
      path: readonly number[],
      content: AttachmentContent,
    ) {
      const key = path.join(".");
      const cached = messages.get(key);
      if (cached) return yield* Effect.fromResult(cached);
      const parsed = yield* parseMessage(content).pipe(
        Effect.flatMap((value) =>
          charge(
            value.attachments.reduce((n, a) => n + a.size, 0) +
              Buffer.byteLength(value.html || "") +
              Buffer.byteLength(value.text ?? ""),
          ).pipe(Effect.as(value)),
        ),
        Effect.result,
      );
      messages.set(key, parsed);
      return yield* Effect.fromResult(parsed);
    });
    const childParts = Effect.fnUntraced(function* (
      path: readonly number[],
      content: AttachmentContent,
    ): Effect.fn.Return<AttachmentContent[], PerformError> {
      const key = path.join(".");
      const cached = containers.get(key);
      if (cached) return yield* Effect.fromResult(cached);
      const result = yield* Effect.gen(function* () {
        if (isTnef(content)) {
          const files = yield* Effect.try({
            try: () => decodeTnef(content.data),
            catch: (error) =>
              new ProviderError({
                message: error instanceof Error ? error.message : String(error),
              }),
          });
          // Count even shared byte views, so budget checks cannot hide ancestor sizes.
          yield* charge(files.reduce((n, file) => n + file.data.byteLength, 0));
          return files;
        }
        const parsed = yield* parsedMessage(path, content);
        return parsed.attachments
          .filter((a) => !a.related)
          .map((a) => ({
            filename: a.filename ?? "attachment",
            mimeType: a.contentType,
            data: a.content,
          }));
      }).pipe(Effect.result);
      containers.set(key, result);
      return yield* Effect.fromResult(result);
    });
    const node = Effect.fnUntraced(function* (
      path: readonly number[],
    ): Effect.fn.Return<AttachmentContent, PerformError> {
      const first = path[0];
      if (
        first === undefined ||
        path.length > 8 ||
        path.some((i) => !Number.isSafeInteger(i) || i < 0)
      )
        return yield* new InvalidInput({ message: "Invalid attachment path" });
      let found: AttachmentContent | undefined;
      for (let depth = 1; depth <= path.length; depth++) {
        const prefix = path.slice(0, depth);
        const key = prefix.join(".");
        const cached = nodes.get(key);
        if (cached) {
          found = yield* Effect.fromResult(cached);
          continue;
        }
        const parent = found;
        const index = prefix.at(-1);
        if (index === undefined)
          return yield* new InvalidInput({ message: "Invalid attachment path" });
        const result = yield* Effect.gen(function* () {
          if (!parent) {
            if ((message.attachments[first]?.size ?? 0) > MAX_ATTACHMENT_CONTAINER_BYTES)
              return yield* new InvalidInput({
                message: "Attachment exceeds the 32 MB reader limit",
              });
            const content = yield* attachment(messageId, first);
            yield* charge(content.data.byteLength);
            return content;
          }
          const child = (yield* childParts(path.slice(0, depth - 1), parent))[index];
          if (!child) return yield* new NotFound({ what: "attachment", id: `${messageId}#${key}` });
          return child;
        }).pipe(Effect.result);
        nodes.set(key, result);
        found = yield* Effect.fromResult(result);
      }
      if (!found) return yield* new InvalidInput({ message: "Invalid attachment path" });
      return found;
    });
    const expand = Effect.fnUntraced(function* (listed: readonly ReaderAttachment[]) {
      const out: ReaderAttachment[] = [];
      for (const item of listed) {
        if (!isTnef(item) || item.path.length >= 8) {
          out.push(item);
          continue;
        }
        const decoded = yield* node(item.path).pipe(
          Effect.flatMap((content) => childParts(item.path, content)),
          Effect.result,
        );
        if (
          decoded._tag === "Failure" ||
          !decoded.success.length ||
          out.length + decoded.success.length > MAX_CONTAINER_PARTS
        ) {
          out.push({ ...item, decodeError: true });
          continue;
        }
        for (const [index, content] of decoded.success.entries())
          out.push(
            descriptor({ ...content, size: content.data.byteLength }, [...item.path, index]),
          );
      }
      return out;
    });
    return { message, node, parsedMessage, expand, charge };
  });
  const parts = Effect.fn("Mailbox.attachmentParts")(function* (
    messageId: string,
    paths: readonly (readonly number[])[],
  ): Effect.fn.Return<AttachmentPartResult[], PerformError> {
    if (!paths.length || paths.length > MAX_CONTAINER_PARTS)
      return yield* new InvalidInput({ message: "Select 1 to 256 attachments" });
    const tree = yield* openTree(messageId);
    const out: AttachmentPartResult[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const key = JSON.stringify(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const result = yield* tree.node(path).pipe(
        Effect.flatMap((content) =>
          (path.length > 1 ? tree.charge(content.data.byteLength) : Effect.void).pipe(
            Effect.as(content),
          ),
        ),
        Effect.result,
      );
      if (result._tag === "Failure")
        out.push({
          kind: "failed",
          path,
          filename: attachmentFilename(
            tree.message.attachments[path[0] ?? -1]?.filename ?? `attachment ${path.join(".")}`,
          ),
          error: result.failure,
        });
      else
        out.push({
          kind: "file",
          path,
          content: {
            ...result.success,
            filename: attachmentFilename(result.success.filename),
            data: path.length > 1 ? new Uint8Array(result.success.data) : result.success.data,
          },
        });
    }
    return out;
  });
  const part = Effect.fn("Mailbox.attachmentPart")(function* (
    messageId: string,
    path: readonly number[],
  ) {
    const result = (yield* parts(messageId, [path]))[0];
    if (!result) return yield* new InvalidInput({ message: "Invalid attachment path" });
    if (result.kind === "failed") return yield* result.error;
    return result.content;
  });
  const list = Effect.fn("Mailbox.readerAttachments")(function* (messageId: string) {
    const tree = yield* openTree(messageId);
    return yield* tree.expand(tree.message.attachments.map((a, index) => descriptor(a, [index])));
  });
  const embedded = Effect.fn("Mailbox.embeddedMessage")(function* (
    messageId: string,
    path: readonly number[],
  ): Effect.fn.Return<EmbeddedMessage, PerformError> {
    const tree = yield* openTree(messageId);
    const parsed = yield* tree.parsedMessage(path, yield* tree.node(path));
    const inline: Record<string, string> = {};
    let inlineBytes = 0;
    for (const a of parsed.attachments) {
      const cid = a.cid ?? a.contentId?.replace(/^<|>$/g, "");
      if (!cid || !a.contentType.startsWith("image/")) continue;
      inlineBytes += a.size;
      if (inlineBytes > 8 * 1024 * 1024) break;
      inline[cid] = `data:${a.contentType};base64,${a.content.toString("base64")}`;
    }
    const attachments = parsed.attachments
      .filter((a) => !a.related)
      .map((a, index) =>
        descriptor(
          { filename: a.filename ?? "attachment", mimeType: a.contentType, size: a.size },
          [...path, index],
        ),
      );
    const html = preservedComposeHtml(
      parsed.html || `<pre>${escapeComposeText(parsed.text ?? "")}</pre>`,
    );
    return {
      subject: parsed.subject ?? "",
      from: parsed.from?.text ?? "",
      to: Array.isArray(parsed.to)
        ? parsed.to.map((a) => a.text).join(", ")
        : (parsed.to?.text ?? ""),
      cc: Array.isArray(parsed.cc)
        ? parsed.cc.map((a) => a.text).join(", ")
        : (parsed.cc?.text ?? ""),
      date: parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date.toISOString() : "",
      bodyHtml: prepareMessageHtml(html, { inline }).html,
      attachments: yield* tree.expand(attachments),
    };
  });
  return {
    attachmentPart: part,
    attachmentParts: parts,
    readerAttachments: list,
    embeddedMessage: embedded,
  };
}
