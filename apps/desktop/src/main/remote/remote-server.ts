import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { attachmentFilename, COMPOSE_ATTACHMENT_LIMIT, type Provider } from "@openmail/core/schema";
import { MAX_RPC_FRAME } from "../../shared/channel";
import { REMOTE_SESSION_PATH } from "../../shared/remote-access";
import {
  checkOrigin,
  checkRequest,
  type GateConfig,
  type GateResult,
  requestLogin,
  type Sessions,
} from "./remote-auth";
import { MAX_CONCURRENT_UPLOADS, readBody, readUpload, UPLOAD_SLACK } from "./remote-upload";

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

/** The web build's page (vite.web.config.ts). Every app route serves it. */
const APP_DOCUMENT = "web.html";

/** The page a tailnet login outside the allowlist gets, in the Mac's UI language. */
export interface ForbiddenText {
  lang: string;
  title: string;
  /** Takes the login as plain text; the page escapes the result. */
  detail: (login: string) => string;
  fix: (login: string) => string;
}

export const ENGLISH_FORBIDDEN: ForbiddenText = {
  lang: "en",
  title: "This login can't open OpenMail",
  detail: (login) =>
    `Tailscale signed you in as ${login}, and that login isn't on this Mac's list.`,
  fix: (login) =>
    `To allow it, open OpenMail on the Mac, go to Settings → Remote access and add ${login} under Who can sign in.`,
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? "",
  );

/** A static page: no scripts, no remote resources, every text escaped. */
export function forbiddenPage(text: ForbiddenText, login: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(text.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(text.title)}</title>
<style>
body { font: 17px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0;
  padding: max(2rem, env(safe-area-inset-top)) max(1.5rem, env(safe-area-inset-right))
  max(2rem, env(safe-area-inset-bottom)) max(1.5rem, env(safe-area-inset-left)); }
main { max-width: 34rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(text.title)}</h1>
<p>${escapeHtml(text.detail(login))}</p>
<p>${escapeHtml(text.fix(login))}</p>
</main>
</body>
</html>
`;
}

/** Expired sessions lose their sockets this often. */
const SWEEP_MS = 60_000;

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

interface RemoteServerOptions {
  /** The built web app (web.html and assets). */
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
  /** The account's provider, or null when there is no such account. */
  provider: (accountId: string) => Promise<Provider | null>;
  onConnection: ConnectionListener;
  /** Refused request reasons, for stderr. Never logins, paths or bodies. */
  log?: (reason: string) => void;
  /** The not-allowed page's text in the Mac's UI language; English without it. */
  forbiddenText?: () => Promise<ForbiddenText>;
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
const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: OutgoingHttpHeaders = {},
) =>
  send(response, status, JSON.stringify(value), { "content-type": "application/json", ...headers });

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

/**
 * Serves a file from the web build. Paths without an extension are app routes
 * (browser history) and get the app document; `appHeaders` runs only then.
 */
async function serveStatic(
  root: string,
  pathname: string,
  response: ServerResponse,
  head: boolean,
  appHeaders: () => OutgoingHttpHeaders,
) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    send(response, 400);
    return;
  }
  // \p{Cc} covers NUL, the C0 controls, DEL and the C1 controls.
  if (/\p{Cc}/u.test(decoded)) {
    send(response, 400);
    return;
  }
  const relative = path.posix.normalize(decoded).replace(/^\/+/, "");
  const wantsApp = relative === "" || !path.posix.extname(relative);
  const file = path.join(root, wantsApp ? APP_DOCUMENT : relative);
  let real: string;
  let size: number;
  try {
    real = await realpath(file);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error("outside");
    const info = await stat(real);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    send(response, 404, "Not found");
    return;
  }
  const immutable = real.startsWith(path.join(root, "assets") + path.sep);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": TYPES[path.extname(real)] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": immutable ? "private, max-age=31536000, immutable" : "no-store",
    ...(wantsApp ? appHeaders() : {}),
  });
  if (head) response.end();
  else createReadStream(real).pipe(response);
}

/** GET /api/attachment?message=&part=: always a download, never rendered in this origin. */
async function handleAttachment(
  url: URL,
  response: ServerResponse,
  attachment: RemoteServerOptions["attachment"],
) {
  const messageId = url.searchParams.get("message");
  const part = parsePartPath(url.searchParams.get("part"));
  if (!messageId || messageId.length > 1024 || !part) return send(response, 400);
  try {
    const content = await attachment(messageId, part);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "application/octet-stream",
      "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": contentDisposition(content.filename),
      "content-length": content.data.byteLength,
      "cache-control": "no-store",
    });
    const chunk = 256 * 1024;
    for (let offset = 0; offset < content.data.byteLength; offset += chunk) {
      if (!response.write(content.data.subarray(offset, offset + chunk)))
        await new Promise<void>((resolve) => {
          response.once("drain", resolve);
        });
    }
    response.end();
  } catch {
    if (!response.headersSent) send(response, 404, "Not found");
    else response.destroy();
  }
}

/** POST /api/upload?account=: compose attachments, checked against that account's limits. */
async function handleUpload(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  provider: RemoteServerOptions["provider"],
) {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^multipart\/form-data;/i.test(contentType)) return send(response, 415);
  const accountId = url.searchParams.get("account");
  const accountProvider = accountId ? await provider(accountId) : null;
  if (!accountProvider)
    return sendJson(response, 400, { error: "invalid" }, { connection: "close" });
  const body = await readBody(request, COMPOSE_ATTACHMENT_LIMIT + UPLOAD_SLACK);
  const result =
    body instanceof Uint8Array ? await readUpload(body, contentType, accountProvider) : body;
  if (result.ok) return sendJson(response, 200, { files: result.files });
  return sendJson(
    response,
    result.status,
    { error: result.error, filename: result.filename },
    // An unread body would otherwise sit in the socket.
    body instanceof Uint8Array ? {} : { connection: "close" },
  );
}

/** Fetch metadata where the browser sends it: only the page itself may ask for a session. */
function sameSite(request: IncomingMessage) {
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}

/**
 * The 127.0.0.1-only HTTP and WebSocket server Tailscale Serve proxies to.
 * Every request passes the identity gate; pages get a session cookie, and
 * WebSocket, download and upload requests must present it.
 */
export async function startRemoteServer(options: RemoteServerOptions) {
  const root = await realpath(options.webRoot);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RPC_FRAME });
  let uploads = 0;
  // Which web build this is: a page from another build reloads after reconnecting.
  const build = createHash("sha256")
    .update(await readFile(path.join(root, APP_DOCUMENT)).catch(() => ""))
    .digest("hex")
    .slice(0, 16);
  const refuse = async (
    gate: GateResult & { ok: false },
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    options.log?.(gate.reason);
    const login = requestLogin(request.headers);
    // A person's own browser, signed in to the tailnet as someone the list doesn't name: say how to fix it.
    if (gate.reason === "not-allowed" && login && request.method === "GET") {
      const text = await (options.forbiddenText?.() ?? Promise.resolve(ENGLISH_FORBIDDEN)).catch(
        () => ENGLISH_FORBIDDEN,
      );
      return send(response, gate.status, forbiddenPage(text, login), {
        "content-type": "text/html; charset=utf-8",
      });
    }
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
  const sameOrigin = (request: IncomingMessage) => {
    const config = options.gate();
    return config !== null && checkOrigin(request.headers, config);
  };
  const session = (request: IncomingMessage, login: string) =>
    options.sessions.find(request.headers.cookie, login);

  const server = createServer((request, response) => {
    void (async () => {
      const gate = identify(request);
      if (!gate.ok) return refuse(gate, request, response);
      const url = new URL(request.url ?? "/", "http://remote.invalid");
      const method = request.method ?? "GET";

      if (url.pathname.startsWith("/api/")) {
        const owner = session(request, gate.login);
        if (url.pathname === REMOTE_SESSION_PATH && method === "GET") {
          if (owner)
            return sendJson(
              response,
              200,
              { build },
              { "set-cookie": options.sessions.refresh(owner) },
            );
          // The page checks its session before it reconnects. A browser that
          // passed the gate gets a new session, as loading the page gives it,
          // unless the Mac ended its session or the request came from another site.
          if (options.sessions.isRevoked(request.headers.cookie) || !sameSite(request))
            return send(response, 401, "Sign in again");
          return sendJson(
            response,
            200,
            { build },
            { "set-cookie": options.sessions.issue(gate.login, gate.name) },
          );
        }
        if (!owner) return send(response, 401, "Sign in again");
        if (url.pathname === "/api/attachment" && method === "GET")
          return handleAttachment(url, response, options.attachment);
        if (url.pathname === "/api/upload" && method === "POST") {
          if (!sameOrigin(request)) return send(response, 403, "Forbidden");
          if (uploads >= MAX_CONCURRENT_UPLOADS)
            return sendJson(
              response,
              503,
              { error: "busy" },
              { connection: "close", "retry-after": "2" },
            );
          uploads++;
          try {
            return await handleUpload(request, url, response, options.provider);
          } finally {
            uploads--;
          }
        }
        return send(response, 404, "Not found");
      }

      if (method !== "GET" && method !== "HEAD") return send(response, 405, "", { allow: "GET" });
      // Only the app document starts a session; assets and misses don't.
      await serveStatic(root, url.pathname, response, method === "HEAD", () =>
        session(request, gate.login)
          ? {}
          : { "set-cookie": options.sessions.issue(gate.login, gate.name) },
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
    if (!sameOrigin(request)) return reject(403, "bad-origin");
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

  const sweeper = setInterval(() => options.sessions.sweep(), SWEEP_MS);
  sweeper.unref();
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
        clearInterval(sweeper);
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
export type RemoteServer = Awaited<ReturnType<typeof startRemoteServer>>;
