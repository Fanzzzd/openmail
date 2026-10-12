import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import {
  REMOTE_HTTPS_PORT,
  REMOTE_SERVICE_PORT,
  type TailscaleState,
} from "../../shared/remote-access";

/** The CLI inside the Mac app from tailscale.com/download. OpenMail never installs it. */
const TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface CliResult {
  code: number;
  stdout: string;
}
export type CliRunner = (args: readonly string[]) => Promise<CliResult>;

export const NOT_INSTALLED: TailscaleState = {
  installed: false,
  running: false,
  tailnet: null,
  dnsName: null,
  suffix: null,
  login: null,
  https: false,
};

/** Runs the bundled CLI with a fixed argv; no shell, bounded time and output. */
export const runTailscale =
  (cli = TAILSCALE_CLI): CliRunner =>
  (args) =>
    new Promise((resolve) => {
      execFile(
        cli,
        [...args],
        { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TERM: "dumb" } },
        (error, stdout) => {
          const code =
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : error.killed
                  ? 124
                  : 1;
          resolve({ code, stdout });
        },
      );
    });

export const cliInstalled = (cli = TAILSCALE_CLI) =>
  access(cli, constants.X_OK).then(
    () => true,
    () => false,
  );

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const trimDot = (name: string | null) => (name ? name.replace(/\.$/, "").toLowerCase() : null);

/** Reads `tailscale status --json`: Self.UserID → User[id].LoginName is this Mac's owner. */
export function parseStatus(json: string): TailscaleState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ...NOT_INSTALLED, installed: true };
  }
  const status = record(parsed);
  const self = record(status.Self);
  const users = record(status.User);
  const userId = self.UserID;
  const owner =
    typeof userId === "number" || typeof userId === "string" ? record(users[String(userId)]) : {};
  const tailnet = record(status.CurrentTailnet);
  const certDomains = Array.isArray(status.CertDomains) ? status.CertDomains : [];
  return {
    installed: true,
    running: status.BackendState === "Running",
    tailnet: text(tailnet.Name),
    dnsName: trimDot(text(self.DNSName)),
    suffix: trimDot(text(tailnet.MagicDNSSuffix) ?? text(status.MagicDNSSuffix)),
    login: text(owner.LoginName),
    https: certDomains.length > 0,
  };
}

/** Where the mapping lives: a port on this node, or a Tailscale Service. */
interface ServeTarget {
  /** 127.0.0.1 port of the OpenMail server. */
  port: number;
  /** The port OpenMail used last time; a mapping to it is OpenMail's own, now stale. */
  previousPort?: number;
  /** svc:name, or empty for this node's own name. */
  service: string;
}

const httpsPort = (target: ServeTarget) =>
  target.service ? REMOTE_SERVICE_PORT : REMOTE_HTTPS_PORT;
const backend = (port: number) => `http://127.0.0.1:${port}`;

/** `tailscale serve` argv. Serve only: Funnel is never part of it. */
export function serveOnArgs(target: ServeTarget): string[] {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)
    throw new Error("Invalid port");
  return [
    "serve",
    ...(target.service ? [`--service=${target.service}`] : []),
    "--bg",
    `--https=${httpsPort(target)}`,
    backend(target.port),
  ];
}

export function serveOffArgs(target: Pick<ServeTarget, "service">): string[] {
  return [
    "serve",
    ...(target.service ? [`--service=${target.service}`] : []),
    `--https=${target.service ? REMOTE_SERVICE_PORT : REMOTE_HTTPS_PORT}`,
    "off",
  ];
}

export const SERVE_STATUS_ARGS = ["serve", "status", "--json"] as const;
export const STATUS_ARGS = ["status", "--json"] as const;

/** The host name browsers use, and the Host header Serve forwards. */
export function publicHost(state: TailscaleState, service: string): string | null {
  if (service) return state.suffix ? `${service.slice("svc:".length)}.${state.suffix}` : null;
  return state.dnsName;
}

export function publicUrl(state: TailscaleState, service: string): string | null {
  const host = publicHost(state, service);
  if (!host) return null;
  return service ? `https://${host}` : `https://${host}:${REMOTE_HTTPS_PORT}`;
}

type ServeCheck =
  | { kind: "free" }
  | { kind: "ours" }
  | { kind: "stale" }
  | { kind: "conflict"; reason: "port" | "handlers" | "funnel" | "tcp" | "foreground" };

const normalizeProxy = (value: unknown) => {
  const raw = text(value);
  if (!raw) return null;
  const withScheme = /^[a-z+]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
    return `${url.protocol}//${host}:${url.port}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return null;
  }
};

/** Checks one ServeConfig (the node's, a service's or a foreground session's). */
function checkConfig(
  config: Record<string, unknown>,
  port: number,
  target: ServeTarget,
): ServeCheck {
  const tcp = record(config.TCP)[String(port)];
  const webEntries = Object.entries(record(config.Web)).filter(([hostPort]) =>
    hostPort.endsWith(`:${port}`),
  );
  const funnel = Object.entries(record(config.AllowFunnel)).some(
    ([hostPort, on]) => hostPort.endsWith(`:${port}`) && on === true,
  );
  if (funnel) return { kind: "conflict", reason: "funnel" };
  if (tcp === undefined && webEntries.length === 0) return { kind: "free" };
  const tcpHandler = record(tcp);
  if (tcp !== undefined && tcpHandler.HTTPS !== true) return { kind: "conflict", reason: "tcp" };
  if (tcpHandler.TCPForward !== undefined || tcpHandler.TerminateTLS !== undefined)
    return { kind: "conflict", reason: "tcp" };
  if (webEntries.length === 0) return { kind: "conflict", reason: "port" };
  let stale = false;
  for (const [, web] of webEntries) {
    const handlers = Object.entries(record(record(web).Handlers));
    if (handlers.length !== 1) return { kind: "conflict", reason: "handlers" };
    const [path, handler] = handlers[0] ?? ["", undefined];
    const proxy = normalizeProxy(record(handler).Proxy);
    if (path !== "/") return { kind: "conflict", reason: "handlers" };
    if (proxy === backend(target.port)) continue;
    if (target.previousPort && proxy === backend(target.previousPort)) stale = true;
    else return { kind: "conflict", reason: "handlers" };
  }
  return stale ? { kind: "stale" } : { kind: "ours" };
}

/**
 * Compares `tailscale serve status --json` with the mapping OpenMail wants. A
 * port already mapped to exactly our backend is ours; anything else on that
 * port, or Funnel on it, is a conflict OpenMail refuses to overwrite.
 */
export function checkServe(json: string, target: ServeTarget): ServeCheck {
  let parsed: unknown;
  try {
    parsed = json.trim() ? JSON.parse(json) : {};
  } catch {
    return { kind: "conflict", reason: "port" };
  }
  const root = record(parsed);
  const port = httpsPort(target);
  for (const session of Object.values(record(root.Foreground))) {
    const check = checkConfig(record(session), port, target);
    if (check.kind !== "free") return { kind: "conflict", reason: "foreground" };
  }
  if (target.service) {
    const service = record(record(root.Services)[target.service]);
    return checkConfig(service, port, target);
  }
  return checkConfig(root, port, target);
}
