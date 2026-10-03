import { Context } from "effect";
import { ProviderError, InvalidInput } from "../errors.js";
import { Buffer } from "./bytes.js";

/** TCP/TLS only. Protocol commands and credentials stay in core. */
export interface MailSocket {
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  startTLS(): Promise<void>;
  close(): void;
}
export class MailTransport extends Context.Service<
  MailTransport,
  {
    connect(options: {
      host: string;
      port: number;
      tls: boolean;
      signal: AbortSignal;
    }): Promise<MailSocket>;
  }
>()("openmail/MailTransport") {}

/** Await each bridge write so large MIME never becomes one base64 native message. */
export async function writeMailChunks(socket: MailSocket, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
    await socket.write(bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length)));
}

export class MailWire {
  private readonly chunks: Uint8Array[] = [];
  private head = 0;
  private offset = 0;
  private length = 0;
  constructor(readonly socket: MailSocket) {}
  async bytes(size: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024)
      throw new ProviderError({ message: "Mail response exceeds 25 MiB" });
    while (this.length < size) await this.more();
    const value = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const chunk = this.chunks[this.head];
      if (!chunk) throw new ProviderError({ message: "Missing buffered mail bytes" });
      const count = Math.min(size - written, chunk.length - this.offset);
      value.set(chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      this.length -= count;
      if (this.offset === chunk.length) {
        this.head++;
        this.offset = 0;
      }
    }
    if (this.head === this.chunks.length) {
      this.chunks.length = 0;
      this.head = 0;
    } else if (this.head >= 128) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
    return value;
  }
  private async more() {
    const next = await this.socket.read();
    if (!next.length) throw new ProviderError({ message: "Mail connection closed" });
    this.length += next.length;
    if (this.length > 26 * 1024 * 1024)
      throw new ProviderError({ message: "Mail response too large" });
    this.chunks.push(next);
  }
  async line(): Promise<string> {
    let index = this.head;
    let offset = this.offset;
    let scanned = 0;
    let carriageReturn = false;
    for (;;) {
      const chunk = this.chunks[index];
      if (!chunk) {
        await this.more();
        continue;
      }
      while (offset < chunk.length) {
        const byte = chunk[offset++];
        scanned++;
        if (carriageReturn && byte === 10) {
          const line = Buffer.from(await this.bytes(scanned - 2)).toString("utf8");
          await this.bytes(2);
          return line;
        }
        if (scanned > 256 * 1024)
          throw new ProviderError({ message: "Mail response line too large" });
        carriageReturn = byte === 13;
      }
      index++;
      offset = 0;
    }
  }
  /** Parse a complete SMTP reply; every continuation uses the first status code. */
  async smtpReply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    let firstCode: number | undefined;
    for (let i = 0; i < 100; i++) {
      const line = await this.line();
      if (!/^\d{3}[- ]/.test(line)) throw new ProviderError({ message: "Invalid SMTP response" });
      const code = Number(line.slice(0, 3));
      if (firstCode !== undefined && code !== firstCode)
        throw new ProviderError({ message: "Inconsistent SMTP response code" });
      firstCode = code;
      lines.push(line);
      if (line[3] === " ") return { code, lines };
    }
    throw new ProviderError({ message: "SMTP response too large" });
  }
  write(line: string) {
    return writeMailChunks(this.socket, Buffer.from(`${line}\r\n`, "utf8"));
  }
  async upgrade() {
    if (this.length) throw new ProviderError({ message: "Unexpected data before TLS" });
    await this.socket.startTLS();
  }
}

export const mailQuote = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new InvalidInput({ message: "Invalid mail command value" });
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

/** IMAP modified UTF-7 for folder names, independent of a Node runtime. */
export function encodeFolder(value: string): string {
  return value.replace(/&|[^\x20-\x7e]+/g, (part) => {
    if (part === "&") return "&-";
    const bytes = new Uint8Array(part.length * 2);
    for (let i = 0; i < part.length; i++) {
      bytes[i * 2] = part.charCodeAt(i) >> 8;
      bytes[i * 2 + 1] = part.charCodeAt(i) & 255;
    }
    return `&${Buffer.from(bytes).toString("base64").replaceAll("/", ",").replace(/=+$/, "")}-`;
  });
}
export function decodeFolder(value: string): string {
  return value.replace(/&([A-Za-z0-9+,]*)-/g, (_match: string, encoded: string) => {
    if (!encoded) return "&";
    const bytes = Buffer.from(encoded.replaceAll(",", "/"), "base64");
    let text = "";
    for (let i = 0; i + 1 < bytes.length; i += 2)
      text += String.fromCharCode((bytes[i] ?? 0) * 256 + (bytes[i + 1] ?? 0));
    return text;
  });
}

export type ImapValue = string | Uint8Array | ImapValue[];
export interface ImapResponse {
  text: string;
  values: ImapValue[];
  byteLength: number;
}
function tokenize(text: string, literals: Uint8Array[]): ImapValue[] {
  if (/[\0\r\n]/.test(text))
    throw new ProviderError({ message: "Invalid IMAP response characters" });
  const status = /^(\*|[^\s]+) (OK|NO|BAD|PREAUTH|BYE)(?: (.*))?$/i.exec(text);
  if (status) return [status[1] ?? "", status[2] ?? "", status[3] ?? ""];
  if (/^\+(?: |$)/.test(text)) return ["+", text.slice(1).trimStart()];
  let position = 0;
  const list = (depth: number): ImapValue[] => {
    if (depth > 32) throw new ProviderError({ message: "IMAP nesting too deep" });
    const out: ImapValue[] = [];
    while (position < text.length) {
      const char = text[position];
      if (char === " ") {
        position++;
        continue;
      }
      if (char === ")") {
        if (depth === 0)
          throw new ProviderError({ message: "Unexpected IMAP closing parenthesis" });
        position++;
        return out;
      }
      if (char === "(") {
        position++;
        out.push(list(depth + 1));
        continue;
      }
      if (char === '"') {
        position++;
        let value = "";
        let closed = false;
        while (position < text.length) {
          const c = text[position++];
          if (c === '"') {
            closed = true;
            break;
          }
          value += c === "\\" ? (text[position++] ?? "") : c;
        }
        if (!closed) throw new ProviderError({ message: "Invalid IMAP quoted string" });
        out.push(value);
        continue;
      }
      const start = position;
      while (position < text.length && !/[ ()]/.test(text[position] ?? "")) position++;
      const atom = text.slice(start, position);
      const literal = /^\{(\d+)\}$/.exec(atom);
      if (literal) {
        const bytes = literals.shift();
        if (!bytes) throw new ProviderError({ message: "Missing IMAP literal" });
        out.push(bytes);
      } else out.push(atom);
    }
    if (depth > 0) throw new ProviderError({ message: "Unterminated IMAP list" });
    return out;
  };
  return list(0);
}
export class ImapCommandError extends Error {
  constructor(readonly status: string) {
    super("IMAP command rejected");
  }
}
export class ImapWire {
  private tag = 0;
  private commands: Promise<null> = Promise.resolve(null);
  private stopped = false;
  private signal: AbortSignal | undefined;
  /** Bind each lease, including a reused connection, to its caller's cancellation. */
  async run<A>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<A>): Promise<A> {
    const abort = () => {
      this.stopped = true;
      this.wire.socket.close();
    };
    this.signal = signal;
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      return await work(signal);
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.signal === signal) this.signal = undefined;
    }
  }
  private checkActive() {
    this.signal?.throwIfAborted();
    if (this.stopped) throw new Error("IMAP connection closed");
  }
  capabilities = new Set<string>();
  constructor(readonly wire: MailWire) {}
  async response(maxBytes = 26 * 1024 * 1024): Promise<ImapResponse> {
    let text = await this.wire.line();
    const literals: Uint8Array[] = [];
    let total = 0;
    let byteLength = Buffer.byteLength(text) + 2;
    if (byteLength > maxBytes)
      throw new ProviderError({ message: "IMAP command response too large" });
    for (;;) {
      const respText = /^(?:\*|[^\s]+) (?:OK|NO|BAD|PREAUTH|BYE)\b|^\+(?: |$)/i.test(text);
      const match = respText ? null : /\{(\d+)\}$/.exec(text);
      if (!match) break;
      const size = Number(match[1]);
      total += size;
      if (total > 25 * 1024 * 1024 || literals.length >= 256)
        throw new ProviderError({ message: "IMAP response too large" });
      if (size + byteLength > maxBytes)
        throw new ProviderError({ message: "IMAP command response too large" });
      literals.push(await this.wire.bytes(size));
      const continuation = await this.wire.line();
      byteLength += size + Buffer.byteLength(continuation) + 2;
      if (byteLength > maxBytes)
        throw new ProviderError({ message: "IMAP command response too large" });
      text += ` ${continuation}`;
    }
    if (/^\* BYE\b/i.test(text)) throw new ProviderError({ message: "IMAP connection ended" });
    return { text, values: tokenize(text, literals), byteLength };
  }
  command(command: string, literal?: Uint8Array): Promise<ImapResponse[]> {
    const result = this.commands.then(() => this.execute(command, literal));
    this.commands = result.then(
      () => null,
      () => null,
    );
    return result;
  }
  private async execute(command: string, literal?: Uint8Array): Promise<ImapResponse[]> {
    this.checkActive();
    const tag = `M${++this.tag}`;
    await this.wire.write(`${tag} ${command}`);
    const responses: ImapResponse[] = [];
    let sent = false;
    let bytes = 0;
    let textBytes = 0;
    for (;;) {
      this.checkActive();
      const response = await this.response(26 * 1024 * 1024 - bytes);
      bytes += response.byteLength;
      textBytes += Buffer.byteLength(response.text);
      if (textBytes > 4 * 1024 * 1024 || responses.length > 50000)
        throw new ProviderError({ message: "IMAP command response too large" });
      if (response.text.startsWith("+")) {
        if (!literal || sent) throw new ProviderError({ message: "Unexpected IMAP continuation" });
        this.checkActive();
        await writeMailChunks(this.wire.socket, literal);
        await this.wire.write("");
        sent = true;
      } else if (response.text.startsWith(`${tag} `)) {
        if (!response.text.startsWith(`${tag} OK`))
          throw new ImapCommandError(response.text.split(" ")[1] ?? "BAD");
        responses.push(response);
        return responses;
      } else responses.push(response);
    }
  }
  async capability() {
    const responses = await this.command("CAPABILITY");
    this.capabilities = new Set(
      responses.flatMap((r) =>
        /^\* CAPABILITY /i.test(r.text) ? r.text.slice(13).toUpperCase().split(" ") : [],
      ),
    );
  }
  uidNext: number | undefined;
  highestModseq: string | undefined;
  async select(path: string, validity?: string, readOnly = true) {
    const responses = await this.command(
      `${readOnly ? "EXAMINE" : "SELECT"} ${mailQuote(encodeFolder(path))}`,
    );
    this.uidNext = responses
      .map((r) => /\[UIDNEXT (\d+)\]/i.exec(r.text)?.[1])
      .filter(Boolean)
      .map(Number)[0];
    this.highestModseq = responses
      .map((r) => /\[HIGHESTMODSEQ (\d+)\]/i.exec(r.text)?.[1])
      .find(Boolean);
    const found = responses.map((r) => /\[UIDVALIDITY (\d+)\]/i.exec(r.text)?.[1]).find(Boolean);
    if (!found || (validity !== undefined && validity !== found))
      throw new ProviderError({ message: "IMAP UIDVALIDITY changed" });
    return found;
  }
  async search(criteria: string): Promise<number[]> {
    const rows = await this.command(`UID SEARCH ${criteria}`);
    const replies = rows.filter((row) => /^\* SEARCH(?: |$)/i.test(row.text));
    if (replies.length !== 1)
      throw new ProviderError({ message: "Missing or ambiguous IMAP SEARCH response" });
    const text = replies[0]?.text.slice(8).trim() ?? "";
    if (!text) return [];
    const uids = text.split(/\s+/).map(Number);
    if (uids.some((uid) => !Number.isSafeInteger(uid) || uid < 1))
      throw new ProviderError({ message: "Invalid IMAP SEARCH UID" });
    return uids;
  }
}
