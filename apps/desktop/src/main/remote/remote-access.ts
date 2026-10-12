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
  /** First retry delay for a mapping a turn-off couldn't remove; doubles up to retryMaxMs. */
  retryMs?: number;
  retryMaxMs?: number;
}

/** Quitting never waits longer than this for the Tailscale CLI. */
const QUIT_TIMEOUT_MS = 3000;
/** A mapping a turn-off left behind is tried again after this long, then less often. */
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

type Removal = "gone" | "noCli" | "failed";

interface Mapping {
  port: number;
  service: string;
}

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
  /** A mapping that may still point at OpenMail although it is off; removed when Tailscale answers. */
  let leftover: Mapping | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 0;
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

  /**
   * Removes the serve mapping only when it still points at OpenMail.
   * - `gone`: `serve status` ran and no OpenMail mapping is left.
   * - `noCli`: the Tailscale CLI wasn't found, so nothing was checked.
   * - `failed`: Tailscale couldn't be asked or refused; the mapping may remain.
   */
  const removeMapping = async (target: Mapping): Promise<Removal> => {
    if (!(await deps.installed())) return "noCli";
    const current = await runCli(SERVE_STATUS_ARGS);
    if (current.code !== 0) return "failed";
    if (checkServe(current.stdout, target).kind !== "ours") return "gone";
    return (await runCli(serveOffArgs(target))).code === 0 ? "gone" : "failed";
  };

  const forget = () => {
    leftover = null;
    clearTimeout(retry);
    retry = undefined;
    retryDelay = 0;
  };
  /**
   * Tries the leftover mapping once. Only a confirmed `gone` forgets it and
   * clears the stored port; otherwise the next launch or Refresh tries again.
   */
  const sweep = async (): Promise<Removal> => {
    if (!leftover) return "gone";
    clearTimeout(retry);
    retry = undefined;
    const result = await removeMapping(leftover).catch((): Removal => "failed");
    if (result !== "gone") return result;
    forget();
    if (problem === "removeFailed") {
      status = "off";
      problem = null;
    }
    // Off and the mapping is confirmed gone: the next launch has nothing to sweep.
    if (!settings.enabled && settings.port) await save({ ...settings, port: 0 });
    return "gone";
  };
  /**
   * After a turn-off couldn't remove the mapping, retries in the background,
   * backing off to retryMaxMs. Stops once the status is no longer removeFailed.
   */
  const armRetry = () => {
    const first = deps.retryMs ?? RETRY_MS;
    retryDelay = retryDelay ? Math.min(retryDelay * 2, deps.retryMaxMs ?? RETRY_MAX_MS) : first;
    retry = setTimeout(() => {
      serial(async () => {
        if (problem !== "removeFailed") return;
        if ((await sweep()) !== "gone") armRetry();
        emit();
      }).catch(() => null);
    }, retryDelay);
    retry.unref();
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
    // The check above already replaced any older mapping for this target.
    if (leftover?.service === settings.service) forget();
    url = publicUrl(tailscale, settings.service);
    status = "on";
    emit();
  };

  const unpublish = async () => {
    const port = server?.port ?? settings.port;
    leftover = port ? { port, service: settings.service } : null;
    retryDelay = 0;
    // Without the CLI nothing can be checked: off, keeping the port for the next try.
    const failed = (await sweep()) === "failed";
    await stopLocal();
    url = null;
    status = failed ? "error" : "off";
    problem = failed ? "removeFailed" : null;
    if (failed) armRetry();
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
        if (settings.enabled) return start();
        // Off, but a crash may have left the mapping behind. One try here; Refresh
        // and the next launch try again. No timer, so a stopped Tailscale isn't polled.
        if (settings.port) {
          leftover = { port: settings.port, service: settings.service };
          await sweep();
        }
        emit();
      }),
    /** Reads `tailscale status` again; retries a failed start or a mapping left behind. */
    refresh: () =>
      serial(async () => {
        if ((await sweep()) !== "gone" && problem === "removeFailed") armRetry();
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
        forget();
        const port = server?.port ?? settings.port;
        if ((status === "on" || status === "starting") && port) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            removeMapping({ port, service: settings.service }).catch(() => null),
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
