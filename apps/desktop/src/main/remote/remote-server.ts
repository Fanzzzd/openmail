import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  attachmentFilename,
  attachmentSizesProblem,
  COMPOSE_ATTACHMENT_LIMIT,
  type OutgoingAttachment,
  type Provider,
} from "@openmail/core/schema";
import { MAX_RPC_FRAME } from "../../shared/channel";
import {
  checkOrigin,
  checkRequest,
  type GateConfig,
  type GateResult,
  type RemoteSessionHandle,
  type Sessions,
} from "./remote-auth";

/** The page's policy: same-origin scripts and connections, never framed. */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: cid:",
  "font-src 'self' data:",
  "frame-src 'self' about:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: OutgoingHttpHeaders = {
  "content-security-policy": WEB_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

/** Multipart overhead allowed on top of the compose limit. */
const UPLOAD_SLACK = 1024 * 1024;
const MAX_UPLOAD_FILES = 64;

export interface RemoteConnection {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
}
export interface ConnectionHandlers {
  message(frame: string): void;
  closed(): void;
}
/** Hands each authenticated WebSocket to the RPC protocol. */
export type ConnectionListener = (connection: RemoteConnection) => ConnectionHandlers;

export interface RemoteServerOptions {
  /** The built web app (index.html and assets). */
  webRoot: string;
  /** 0 picks a free port. */
  port: number;
  /** Null while Tailscale details are unknown: every request is refused. */
  gate: () => GateConfig | null;
  sessions: Sessions;
  attachment: (
    messageId: string,
    path: readonly number[],
  ) => Promise<{ filename: string; data: Uint8Array }>;
  provider: (accountId: string) => Promise<Provider | null>;
  onConnection: ConnectionListener;
  /** Refused request reasons, for stderr. Never logins, paths or bodies. */
  log?: (reason: string) => void;
}

const send = (
  response: ServerResponse,
  status: number,
  body: string | Uint8Array = "",
  headers: OutgoingHttpHeaders = {},
) => {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(body);
};

/** Attachment paths travel as dot-separated part indices, like 0 or 2.1. */
export function parsePartPath(value: string | null): number[] | null {
  if (!value || !/^\d{1,4}(?:\.\d{1,4}){0,7}$/.test(value)) return null;
  return value.split(".").map(Number);
}

/** RFC 6266 attachment disposition with an ASCII fallback. */
export function contentDisposition(filename: string): string {
  const safe = attachmentFilename(filename).replace(/[/\\]/g, "_") || "attachment";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["%;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Checks uploaded compose attachments with the desktop limits: 30 MB in total
 * and the provider's blocked types and sizes. Returns base64 attachments.
 */
export async function readUpload(
  body: Buffer,
  contentType: string,
  provider: Provider | null,
): Promise<
  | { ok: true; files: OutgoingAttachment[] }
  | { ok: false; status: number; error: string; filename?: string }
> {
  let form: FormData;
  try {
    form = await new Request("http://upload.invalid/", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();
  } catch {
    return { ok: false, status: 400, error: "invalid" };
  }
  const files = form.getAll("file").flatMap((entry) => (typeof entry === "string" ? [] : [entry]));
  if (files.length === 0 || files.length > MAX_UPLOAD_FILES)
    return { ok: false, status: 400, error: "invalid" };
  const existing = Number(form.get("existingBytes") ?? 0);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isFinite(existing) || existing < 0 || total + existing > COMPOSE_ATTACHMENT_LIMIT)
    return { ok: false, status: 413, error: "tooLarge" };
  const described = files.map((file) => ({
    filename: attachmentFilename(file.name || "attachment"),
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  }));
  const problem = provider ? attachmentSizesProblem(provider, described) : undefined;
  if (problem)
    return {
      ok: false,
      status: problem.kind === "gmailBlocked" ? 415 : 413,
      error: problem.kind,
      ...(problem.kind === "gmailBlocked" ? { filename: problem.filename } : {}),
    };
  const out: OutgoingAttachment[] = [];
  for (const [index, file] of files.entries()) {
    const info = described[index];
    if (!info) continue;
    out.push({
      filename: info.filename,
      mimeType: info.mimeType,
      content: Buffer.from(await file.arrayBuffer()).toString("base64"),
    });
  }
  return { ok: true, files: out };
}

async function serveStatic(
  root: string,
  pathname: string,
  response: ServerResponse,
  head: boolean,
  extraHeaders: OutgoingHttpHeaders,
) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    send(response, 400);
    return;
  }
  // oxlint-disable-next-line no-control-regex
  if (decoded.includes("\0") || /[\u0000-\u001f]/.test(decoded)) {
    send(response, 400);
    return;
  }
  const relative = path.posix.normalize(decoded).replace(/^\/+/, "");
  // Paths without an extension are app routes (browser history); they get the app.
  const wantsApp = relative === "" || !path.posix.extname(relative);
  const file = path.join(root, wantsApp ? "index.html" : relative);
  try {
    const real = await realpath(file);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error("outside");
    const info = await stat(real);
    if (!info.isFile()) throw new Error("not a file");
    const ext = path.extname(real);
    const immutable = real.startsWith(path.join(root, "assets") + path.sep);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": immutable ? "private, max-age=31536000, immutable" : "no-store",
      ...(wantsApp ? extraHeaders : {}),
    });
    if (head) {
      response.end();
      return;
    }
    createReadStream(real).pipe(response);
  } catch {
    send(response, 404, "Not found");
  }
}

/**
 * The 127.0.0.1-only HTTP and WebSocket server Tailscale Serve proxies to.
 * Every request passes the identity gate; pages get a session cookie, and
 * WebSocket, download and upload requests must present it.
 */
export async function startRemoteServer(options: RemoteServerOptions) {
  const root = await realpath(options.webRoot);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RPC_FRAME });
  const refuse = (gate: GateResult & { ok: false }, response: ServerResponse) => {
    options.log?.(gate.reason);
    send(response, gate.status, "Forbidden");
  };
  const identify = (request: IncomingMessage): GateResult => {
    const config = options.gate();
    if (!config) return { ok: false, status: 403, reason: "no-identity" };
    return checkRequest(
      { remoteAddress: request.socket.remoteAddress, headers: request.headers },
      config,
    );
  };
  const session = (request: IncomingMessage, login: string): RemoteSessionHandle | null =>
    options.sessions.find(request.headers.cookie, login);

  const server = createServer((request, response) => {
    void (async () => {
      const gate = identify(request);
      if (!gate.ok) return refuse(gate, response);
      const url = new URL(request.url ?? "/", "http://remote.invalid");
      const method = request.method ?? "GET";

      if (url.pathname.startsWith("/api/")) {
        if (!session(request, gate.login)) return send(response, 401, "Sign in again");
        if (url.pathname === "/api/attachment" && method === "GET") {
          const messageId = url.searchParams.get("message");
          const part = parsePartPath(url.searchParams.get("part"));
          if (!messageId || messageId.length > 1024 || !part) return send(response, 400);
          try {
            const content = await options.attachment(messageId, part);
            response.writeHead(200, {
              ...SECURITY_HEADERS,
              // Never rendered in this origin: always a download, sandboxed if opened.
              "content-type": "application/octet-stream",
              "content-security-policy": "sandbox; default-src 'none'",
              "content-disposition": contentDisposition(content.filename),
              "content-length": content.data.byteLength,
              "cache-control": "no-store",
            });
            const chunk = 256 * 1024;
            for (let offset = 0; offset < content.data.byteLength; offset += chunk) {
              const piece = content.data.subarray(offset, offset + chunk);
              if (!response.write(piece))
                await new Promise<void>((resolve) => {
                  response.once("drain", resolve);
                });
            }
            response.end();
          } catch {
            if (!response.headersSent) send(response, 404, "Not found");
            else response.destroy();
          }
          return;
        }
        if (url.pathname === "/api/upload" && method === "POST") {
          const config = options.gate();
          if (
            !config ||
            !checkOrigin({ remoteAddress: undefined, headers: request.headers }, config)
          )
            return send(response, 403, "Forbidden");
          const contentType = request.headers["content-type"] ?? "";
          if (!/^multipart\/form-data;/i.test(contentType)) return send(response, 415);
          const body = await readBody(request, COMPOSE_ATTACHMENT_LIMIT + UPLOAD_SLACK);
          if (!body)
            return send(response, 413, JSON.stringify({ error: "tooLarge" }), {
              "content-type": "application/json",
              connection: "close",
            });
          const accountId = url.searchParams.get("account");
          const provider = accountId ? await options.provider(accountId) : null;
          const result = await readUpload(body, contentType, provider);
          return result.ok
            ? send(response, 200, JSON.stringify({ files: result.files }), {
                "content-type": "application/json",
              })
            : send(
                response,
                result.status,
                JSON.stringify({ error: result.error, filename: result.filename }),
                { "content-type": "application/json" },
              );
        }
        return send(response, 404, "Not found");
      }

      if (method !== "GET" && method !== "HEAD") return send(response, 405, "", { allow: "GET" });
      const existing = session(request, gate.login);
      const issued = existing ? undefined : options.sessions.issue(gate.login, gate.name);
      await serveStatic(
        root,
        url.pathname,
        response,
        method === "HEAD",
        issued ? { "set-cookie": issued.cookie } : {},
      );
    })().catch(() => {
      if (!response.headersSent) send(response, 500);
      else response.destroy();
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number, reason: string) => {
      options.log?.(reason);
      socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const gate = identify(request);
    if (!gate.ok) return reject(gate.status, gate.reason);
    const config = options.gate();
    if (!config || !checkOrigin({ remoteAddress: undefined, headers: request.headers }, config))
      return reject(403, "bad-origin");
    const url = new URL(request.url ?? "/", "http://remote.invalid");
    if (url.pathname !== "/rpc") return reject(404, "bad-path");
    const owner = session(request, gate.login);
    if (!owner) return reject(401, "no-session");
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const connection: RemoteConnection = {
        send: (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(frame);
        },
        close: (code, reason) => ws.close(code, reason),
      };
      const detach = options.sessions.attach(owner, connection);
      const handlers = options.onConnection(connection);
      ws.on("message", (data, binary) => {
        if (binary) return ws.close(1003, "Text only");
        const frame = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
        handlers.message(frame);
      });
      ws.once("close", () => {
        detach();
        handlers.closed();
      });
    });
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  const port = await new Promise<number>((resolve, reject) => {
    const listen = (wanted: number) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && wanted !== 0) listen(0);
        else reject(error);
      });
      // Loopback only: Tailscale Serve is the sole way in from the tailnet.
      server.listen(wanted, "127.0.0.1", () => {
        server.removeAllListeners("error");
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    };
    listen(options.port);
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
export type RemoteServer = Awaited<ReturnType<typeof startRemoteServer>>;
