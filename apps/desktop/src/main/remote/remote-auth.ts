import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { sameLogin } from "@openmail/core/schema";
import type { RemoteSession } from "../../shared/remote-access";

/** Set by Tailscale Serve on tailnet traffic; Funnel traffic never carries it. */
export const LOGIN_HEADER = "tailscale-user-login";
export const NAME_HEADER = "tailscale-user-name";
/** Serve marks traffic that arrived through Funnel. */
export const FUNNEL_HEADER = "tailscale-funnel-request";
export const SESSION_COOKIE = "__Host-openmail-session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface GateConfig {
  /** Logins that may sign in, compared case-insensitively. */
  allowlist: readonly string[];
  /** The public host, such as mac.tail1234.ts.net. */
  host: string;
  /** The HTTPS port browsers use; 443 is omitted from Host and Origin. */
  port: number;
}

export interface RequestFacts {
  remoteAddress: string | undefined;
  headers: IncomingHttpHeaders;
}

export type GateResult =
  | { ok: true; login: string; name: string }
  | { ok: false; status: 403 | 421; reason: GateReason };
export type GateReason =
  | "not-loopback"
  | "funnel"
  | "no-identity"
  | "bad-host"
  | "not-allowed"
  | "bad-origin"
  | "no-session";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;

export const expectedHosts = (config: Pick<GateConfig, "host" | "port">) => {
  const host = config.host.toLowerCase();
  return config.port === 443 ? [host, `${host}:443`] : [`${host}:${config.port}`];
};
export const expectedOrigin = (config: Pick<GateConfig, "host" | "port">) =>
  config.port === 443
    ? `https://${config.host.toLowerCase()}`
    : `https://${config.host.toLowerCase()}:${config.port}`;

/** Serve sends non-ASCII names as RFC 2047 UTF-8 words. */
export function decodeName(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const word = /^=\?utf-8\?q\?(.*)\?=$/i.exec(value);
  if (!word?.[1]) return value.slice(0, 200);
  try {
    const bytes = word[1]
      .replace(/_/g, " ")
      .replace(/=([0-9a-f]{2})/gi, (_, hex: string) => `%${hex}`);
    return decodeURIComponent(bytes).slice(0, 200);
  } catch {
    return fallback;
  }
}

/**
 * Every request: from 127.0.0.1 (Serve's proxy), never through Funnel, with
 * the Serve identity header, for the tailnet host (so DNS rebinding fails),
 * and from an allowlisted login.
 */
export function checkRequest(facts: RequestFacts, config: GateConfig): GateResult {
  if (!facts.remoteAddress || !LOOPBACK.has(facts.remoteAddress))
    return { ok: false, status: 403, reason: "not-loopback" };
  if (facts.headers[FUNNEL_HEADER] !== undefined)
    return { ok: false, status: 403, reason: "funnel" };
  const login = one(facts.headers[LOGIN_HEADER])?.trim();
  if (!login || login.length > 256 || /[\s,]/.test(login))
    return { ok: false, status: 403, reason: "no-identity" };
  const host = one(facts.headers.host)?.toLowerCase();
  if (!host || !expectedHosts(config).includes(host))
    return { ok: false, status: 421, reason: "bad-host" };
  if (!config.allowlist.some((allowed) => sameLogin(allowed, login)))
    return { ok: false, status: 403, reason: "not-allowed" };
  return { ok: true, login, name: decodeName(one(facts.headers[NAME_HEADER]), login) };
}

/** WebSocket upgrades and uploads also need the page's own origin (no cross-site requests). */
export function checkOrigin(facts: RequestFacts, config: GateConfig): boolean {
  return one(facts.headers.origin) === expectedOrigin(config);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

interface Session {
  id: string;
  login: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  sockets: Set<{ close: (code?: number, reason?: string) => void }>;
}

/**
 * Browser sessions, in memory. The cookie holds a random id and an HMAC under
 * a key made at launch, so restarting OpenMail ends every session. A session
 * belongs to one login; a request with another login does not match it.
 */
export function createSessions(now: () => number = Date.now) {
  const key = randomBytes(32);
  const sessions = new Map<string, Session>();
  const sign = (id: string) => createHmac("sha256", key).update(id).digest("base64url");
  const changes = new Set<() => void>();
  const changed = () => {
    for (const listener of changes) listener();
  };
  const end = (session: Session) => {
    sessions.delete(session.id);
    for (const socket of session.sockets) socket.close(4401, "Session ended");
    session.sockets.clear();
  };
  return {
    /** A new session and its Set-Cookie value. */
    issue(login: string, name: string) {
      const id = randomBytes(24).toString("base64url");
      const at = now();
      sessions.set(id, {
        id,
        login,
        name,
        createdAt: at,
        expiresAt: at + SESSION_TTL_MS,
        lastSeenAt: at,
        sockets: new Set(),
      });
      changed();
      return {
        id,
        cookie: `${SESSION_COOKIE}=${id}.${sign(id)}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`,
      };
    },
    /** The session for a cookie, if it is valid, unexpired and for this login. */
    find(cookieHeader: string | undefined, login: string): Session | null {
      const value = readCookie(cookieHeader, SESSION_COOKIE);
      const [id, mac] = value?.split(".") ?? [];
      if (!id || !mac) return null;
      const expected = Buffer.from(sign(id));
      const given = Buffer.from(mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      const session = sessions.get(id);
      if (!session || !sameLogin(session.login, login)) return null;
      if (session.expiresAt <= now()) {
        end(session);
        changed();
        return null;
      }
      session.lastSeenAt = now();
      return session;
    },
    attach(session: Session, socket: Session["sockets"] extends Set<infer S> ? S : never) {
      session.sockets.add(socket);
      changed();
      return () => {
        session.sockets.delete(socket);
        changed();
      };
    },
    revoke(id: string) {
      const session = sessions.get(id);
      if (session) end(session);
      changed();
    },
    /** Ends sessions whose login left the allowlist, and expired ones. */
    retain(allowlist: readonly string[]) {
      const at = now();
      for (const session of sessions.values())
        if (
          session.expiresAt <= at ||
          !allowlist.some((allowed) => sameLogin(allowed, session.login))
        )
          end(session);
      changed();
    },
    clear() {
      for (const session of sessions.values()) end(session);
      changed();
    },
    list(): RemoteSession[] {
      return [...sessions.values()].map((session) => ({
        id: session.id,
        login: session.login,
        name: session.name,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        connected: session.sockets.size > 0,
      }));
    },
    subscribe(listener: () => void) {
      changes.add(listener);
      return () => changes.delete(listener);
    },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
export type RemoteSessionHandle = NonNullable<ReturnType<Sessions["find"]>>;
