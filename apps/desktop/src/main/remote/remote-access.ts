import {
  DEFAULT_REMOTE_ACCESS,
  type Provider,
  type RemoteAccessSettings,
} from "@openmail/core/schema";
import type { Mailbox } from "@openmail/core";
import { Cause, Effect, Exit } from "effect";
import {
  REMOTE_HTTPS_PORT,
  REMOTE_SERVICE_PORT,
  type RemoteAccessProblem,
  type RemoteAccessView,
  type TailscaleState,
} from "../../shared/remote-access";
import { createSessions, type GateConfig } from "./remote-auth";
import { createConnectionHub, type ConnectionHub } from "./remote-rpc-server";
import { startRemoteServer, type RemoteServer } from "./remote-server";
import {
  checkServe,
  NOT_INSTALLED,
  parseStatus,
  publicHost,
  publicUrl,
  SERVE_STATUS_ARGS,
  serveOffArgs,
  serveOnArgs,
  STATUS_ARGS,
  type CliRunner,
} from "./tailscale";

type MailboxService = Mailbox["Service"];

export interface RemoteAccessDeps {
  mailbox: Pick<MailboxService, "remoteAccess" | "setRemoteAccess" | "attachmentPart" | "accounts">;
  runCli: CliRunner;
  installed: () => Promise<boolean>;
  webRoot: string;
  /** Starts the remote RPC server on the hub; resolves to its stopper. */
  startRpc: (hub: ConnectionHub) => () => Promise<void>;
  log?: (reason: string) => void;
  /** How long quitting waits for `tailscale serve off`. */
  quitTimeoutMs?: number;
}

/** Quitting never waits longer than this for the Tailscale CLI. */
const QUIT_TIMEOUT_MS = 3000;

/** Fails with the Effect's own error (InvalidInput) instead of a wrapped one. */
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/**
 * Remote access on this Mac: the 127.0.0.1 server, the remote RPC server and
 * the `tailscale serve` mapping that publishes them to the tailnet. One
 * operation runs at a time. Turning it off removes only a mapping that points
 * at OpenMail; it never touches anyone else's serve config.
 */
export function createRemoteAccess(deps: RemoteAccessDeps) {
  const { mailbox, runCli } = deps;
  let settings: RemoteAccessSettings = DEFAULT_REMOTE_ACCESS;
  let tailscale: TailscaleState = NOT_INSTALLED;
  let status: RemoteAccessView["status"] = "off";
  let problem: RemoteAccessProblem | null = null;
  let url: string | null = null;
  let server: RemoteServer | undefined;
  let stopRpc: (() => Promise<void>) | undefined;
  let gate: GateConfig | null = null;
  const sessions = createSessions();
  const listeners = new Set<(view: RemoteAccessView) => void>();

  const view = (): RemoteAccessView => ({
    enabled: settings.enabled,
    allowlist: settings.allowlist,
    service: settings.service,
    tailscale,
    status,
    problem,
    url,
    sessions: sessions.list(),
  });
  const emit = () => {
    const current = view();
    for (const listener of listeners) listener(current);
  };
  sessions.subscribe(emit);

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <A>(task: () => Promise<A>): Promise<A> => {
    const next = queue.then(task);
    queue = next.catch(() => null);
    return next;
  };
  const save = async (next: RemoteAccessSettings) => {
    settings = await run(mailbox.setRemoteAccess(next));
    if (gate) gate = { ...gate, allowlist: settings.allowlist };
    sessions.retain(settings.allowlist);
  };

  const detect = async (): Promise<TailscaleState> => {
    if (!(await deps.installed())) return NOT_INSTALLED;
    const result = await runCli(STATUS_ARGS);
    return result.stdout.trim()
      ? parseStatus(result.stdout)
      : { ...NOT_INSTALLED, installed: true };
  };

  const stopLocal = async () => {
    gate = null;
    sessions.clear();
    const stopping = stopRpc;
    stopRpc = undefined;
    await stopping?.();
    const closing = server;
    server = undefined;
    await closing?.close();
  };
  const fail = async (reason: RemoteAccessProblem) => {
    await stopLocal();
    status = "error";
    problem = reason;
    url = null;
    emit();
  };
  const httpsPort = () => (settings.service ? REMOTE_SERVICE_PORT : REMOTE_HTTPS_PORT);

  const startLocal = async () => {
    if (server) return server;
    const hub = createConnectionHub();
    const started = await startRemoteServer({
      webRoot: deps.webRoot,
      port: settings.port,
      gate: () => gate,
      sessions,
      attachment: (messageId, path) => run(mailbox.attachmentPart(messageId, path)),
      provider: async (accountId): Promise<Provider | null> =>
        (await run(mailbox.accounts)).find((account) => account.id === accountId)?.provider ?? null,
      onConnection: hub.onConnection,
      ...(deps.log ? { log: deps.log } : {}),
    });
    server = started;
    stopRpc = deps.startRpc(hub);
    return started;
  };

  const start = async () => {
    status = "starting";
    problem = null;
    emit();
    tailscale = await detect();
    if (!tailscale.installed) return fail("notInstalled");
    if (!tailscale.running || !tailscale.dnsName) return fail("notRunning");
    if (!tailscale.https) return fail("httpsDisabled");
    // The default allowlist is the Mac's own tailnet user, added once.
    if (!settings.ownerSeeded && tailscale.login)
      await save({
        ...settings,
        allowlist: [tailscale.login, ...settings.allowlist],
        ownerSeeded: true,
      });
    const host = publicHost(tailscale, settings.service);
    if (!host) return fail("notRunning");
    let local: RemoteServer;
    try {
      local = await startLocal();
    } catch {
      return fail("serverFailed");
    }
    const previousPort = settings.port;
    if (local.port !== settings.port) await save({ ...settings, port: local.port });
    const current = await runCli(SERVE_STATUS_ARGS);
    if (current.code !== 0) return fail("serveFailed");
    const target = { port: local.port, previousPort, service: settings.service };
    const check = checkServe(current.stdout, target);
    if (check.kind === "conflict") return fail(check.reason === "funnel" ? "funnel" : "conflict");
    if (check.kind === "stale" && (await runCli(serveOffArgs(target))).code !== 0)
      return fail("serveFailed");
    if (check.kind !== "ours" && (await runCli(serveOnArgs(target))).code !== 0)
      return fail("serveFailed");
    gate = { allowlist: settings.allowlist, host, port: httpsPort() };
    url = publicUrl(tailscale, settings.service);
    status = "on";
    emit();
  };

  /** Removes the serve mapping only when it still points at OpenMail. */
  const removeMapping = async () => {
    const port = server?.port ?? settings.port;
    if (!port) return;
    const current = await runCli(SERVE_STATUS_ARGS);
    if (current.code !== 0) return;
    const target = { port, service: settings.service };
    if (checkServe(current.stdout, target).kind === "ours") await runCli(serveOffArgs(target));
  };
  const unpublish = async () => {
    await removeMapping();
    await stopLocal();
    status = "off";
    problem = null;
    url = null;
    emit();
  };

  return {
    view,
    subscribe(listener: (view: RemoteAccessView) => void) {
      listeners.add(listener);
      listener(view());
      return () => {
        listeners.delete(listener);
      };
    },
    /** Loads settings; resumes publishing when the person left it on. */
    init: () =>
      serial(async () => {
        settings = await run(mailbox.remoteAccess);
        if (settings.enabled) await start();
        else emit();
      }),
    /** Reads `tailscale status` again; retries a failed start. */
    refresh: () =>
      serial(async () => {
        if (settings.enabled && status === "error") return start();
        tailscale = await detect();
        emit();
      }),
    setEnabled: (enabled: boolean) =>
      serial(async () => {
        if (enabled === settings.enabled && (enabled ? status === "on" : status === "off")) return;
        await save({ ...settings, enabled });
        await (enabled ? start() : unpublish());
      }),
    setAllowlist: (logins: readonly string[]) =>
      serial(async () => {
        await save({ ...settings, allowlist: logins });
        emit();
      }),
    setService: (service: string) =>
      serial(async () => {
        const next = { ...settings, service };
        await run(mailbox.setRemoteAccess(next).pipe(Effect.asVoid)); // validate first
        if (settings.enabled && status !== "off") await unpublish();
        await save(next);
        if (settings.enabled) await start();
        else emit();
      }),
    /** Closes one browser's session; it reconnects on reload while its login is allowed. */
    disconnect: (id: string) => {
      sessions.disconnect(id);
    },
    /**
     * App quit: remove the serve mapping, so nothing else can take the port
     * behind it while OpenMail is closed, then stop serving. The setting stays
     * on and the next launch publishes again. Quitting waits at most
     * QUIT_TIMEOUT_MS for the CLI.
     */
    dispose: () =>
      serial(async () => {
        if (status === "on" || status === "starting") {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            removeMapping().catch(() => null),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, deps.quitTimeoutMs ?? QUIT_TIMEOUT_MS);
            }),
          ]);
          clearTimeout(timer);
        }
        await stopLocal();
      }),
  };
}
export type RemoteAccessController = ReturnType<typeof createRemoteAccess>;
