import { Schema } from "effect";

/** What `tailscale status --json` says about this Mac. */
export const TailscaleState = Schema.Struct({
  installed: Schema.Boolean,
  running: Schema.Boolean,
  /** The tailnet's display name, such as example.github. */
  tailnet: Schema.NullOr(Schema.String),
  /** This Mac's MagicDNS name, without the trailing dot. */
  dnsName: Schema.NullOr(Schema.String),
  /** The tailnet suffix, such as tail1234.ts.net. */
  suffix: Schema.NullOr(Schema.String),
  /** The login of the tailnet user this Mac belongs to. */
  login: Schema.NullOr(Schema.String),
  /** HTTPS certificates are enabled for the tailnet. */
  https: Schema.Boolean,
});
export type TailscaleState = typeof TailscaleState.Type;

export const RemoteAccessProblem = Schema.Literals([
  "notInstalled",
  "notRunning",
  "httpsDisabled",
  /** Port 8443 (or the service) already serves something else. */
  "conflict",
  /** The mapping allows Funnel. OpenMail never serves through Funnel. */
  "funnel",
  "serveFailed",
  "serverFailed",
  /** Remote access is off, but Tailscale couldn't be asked to remove OpenMail's mapping yet. */
  "removeFailed",
]);
export type RemoteAccessProblem = typeof RemoteAccessProblem.Type;

export const RemoteSession = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  lastSeenAt: Schema.Number,
  connected: Schema.Boolean,
});
export type RemoteSession = typeof RemoteSession.Type;

export const RemoteAccessView = Schema.Struct({
  enabled: Schema.Boolean,
  allowlist: Schema.Array(Schema.String),
  service: Schema.String,
  tailscale: TailscaleState,
  status: Schema.Literals(["off", "starting", "on", "error"]),
  problem: Schema.NullOr(RemoteAccessProblem),
  url: Schema.NullOr(Schema.String),
  sessions: Schema.Array(RemoteSession),
});
export type RemoteAccessView = typeof RemoteAccessView.Type;

/** The HTTPS port on this node. The root (443) is left to the person's own serve config. */
export const REMOTE_HTTPS_PORT = 8443;
/** A Tailscale Service listens on the standard HTTPS port of its own name. */
export const REMOTE_SERVICE_PORT = 443;

/**
 * GET with the session cookie: 200 and `{ build }` while the session holds,
 * 401 once it ended. The web build asks before each reconnect.
 */
export const REMOTE_SESSION_PATH = "/api/session";
