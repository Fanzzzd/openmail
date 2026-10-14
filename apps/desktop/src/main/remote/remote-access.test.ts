import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_REMOTE_ACCESS,
  normalizeRemoteAccess,
  type RemoteAccessSettings,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAccessView } from "../../shared/remote-access";
import { createRemoteAccess, type RemoteAccessDeps } from "./remote-access";
import type { CliResult } from "./tailscale";
import { scaledMs, waitLimit } from "../../../../../packages/core/test-support/test-time.js";

const STATUS = JSON.stringify({
  BackendState: "Running",
  CurrentTailnet: { Name: "owner.github", MagicDNSSuffix: "tail1234.ts.net" },
  CertDomains: ["mac.tail1234.ts.net"],
  Self: { DNSName: "mac.tail1234.ts.net.", UserID: 7 },
  User: { "7": { LoginName: "owner@github" } },
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openmail-remote-"));
  await writeFile(path.join(root, "web.html"), "<!doctype html>");
});
afterEach(() => rm(root, { recursive: true, force: true }));

function harness(options: {
  installed?: boolean;
  status?: string;
  serve?: (port: number) => string;
  settings?: Partial<RemoteAccessSettings>;
  failServeOn?: boolean;
  retryMs?: number;
  retryMaxMs?: number;
}) {
  // Set by hang(): serve commands never return, like a stuck CLI.
  let hanging = false;
  // Set by down(): Tailscale isn't running, so every CLI call fails.
  let down = false;
  // Set by setInstalled(): whether the Tailscale CLI can be found.
  let installed = options.installed ?? true;
  let stored: RemoteAccessSettings = { ...DEFAULT_REMOTE_ACCESS, ...options.settings };
  const calls: string[][] = [];
  let rpcRunning = 0;
  let port = stored.port;
  const deps: RemoteAccessDeps = {
    mailbox: {
      app: {
        remoteAccess: Effect.sync(() => stored),
        setRemoteAccess: (input) =>
          normalizeRemoteAccess(input).pipe(
            Effect.tap((saved) =>
              Effect.sync(() => {
                stored = saved;
                port = saved.port;
              }),
            ),
          ),
      },
      reading: {
        attachmentPart: () => Effect.die("unused"),
      },
      accounts: {
        accounts: Effect.succeed([]),
      },
    },
    installed: async () => installed,
    runCli: async (args): Promise<CliResult> => {
      calls.push([...args]);
      if (hanging && args[0] === "serve") return new Promise<CliResult>(constVoid);
      if (down) return { code: 1, stdout: "" };
      if (args[0] === "status") return { code: 0, stdout: options.status ?? STATUS };
      if (args.join(" ") === "serve status --json")
        return { code: 0, stdout: options.serve?.(port) ?? "{}" };
      if (args.at(-1)?.startsWith("http://") && options.failServeOn) return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    },
    webRoot: root,
    quitTimeoutMs: 50,
    retryMs: options.retryMs ?? 20,
    ...(options.retryMaxMs ? { retryMaxMs: options.retryMaxMs } : {}),
    startRpc: (hub) => {
      rpcRunning++;
      const stop = hub.listen(() => ({ message: constVoid, closed: constVoid }));
      return async () => {
        stop();
        rpcRunning--;
      };
    },
  };
  const controller = createRemoteAccess(deps);
  const views: RemoteAccessView[] = [];
  controller.subscribe((view) => views.push(view));
  return {
    controller,
    calls,
    views,
    stored: () => stored,
    rpcRunning: () => rpcRunning,
    last: () => views.at(-1),
    hang: () => {
      hanging = true;
    },
    tailscaleDown: (value: boolean) => {
      down = value;
    },
    setInstalled: (value: boolean) => {
      installed = value;
    },
  };
}

const ours = (port: number) =>
  JSON.stringify({
    TCP: { "8443": { HTTPS: true } },
    Web: {
      "mac.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } },
    },
  });

describe("remote access controller", () => {
  it("is off by default and runs no Tailscale command until asked", async () => {
    const h = harness({});
    await h.controller.init();
    expect(h.last()).toMatchObject({ enabled: false, status: "off", url: null });
    expect(h.calls).toEqual([]);
    expect(h.rpcRunning()).toBe(0);
  });

  it("turns on: reads status, checks serve, then maps 8443 to its loopback port", async () => {
    const h = harness({});
    await h.controller.init();
    await h.controller.setEnabled(true);
    const port = h.stored().port;
    expect(port).toBeGreaterThan(0);
    expect(h.calls).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
      ["serve", "--bg", "--https=8443", `http://127.0.0.1:${port}`],
    ]);
    expect(h.last()).toMatchObject({
      enabled: true,
      status: "on",
      url: "https://mac.tail1234.ts.net:8443",
      // The default allowlist is this Mac's own tailnet user.
      allowlist: ["owner@github"],
    });
    expect(h.rpcRunning()).toBe(1);
    await h.controller.dispose();
  });

  it("turns off by removing only its own mapping", async () => {
    const h = harness({ serve: ours });
    await h.controller.init();
    await h.controller.setEnabled(true);
    // Already mapped to this port: no second serve command.
    expect(h.calls.filter((args) => args.includes("--bg"))).toEqual([]);
    h.calls.length = 0;
    await h.controller.setEnabled(false);
    expect(h.calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--https=8443", "off"],
    ]);
    expect(h.last()).toMatchObject({ enabled: false, status: "off", url: null });
    expect(h.rpcRunning()).toBe(0);
  });

  it("refuses to overwrite a conflicting mapping and leaves it alone when turned off", async () => {
    const other = () => ours(3000);
    const h = harness({ serve: other });
    await h.controller.init();
    await h.controller.setEnabled(true);
    expect(h.last()).toMatchObject({ status: "error", problem: "conflict", url: null });
    expect(h.calls.some((args) => args.includes("--bg"))).toBe(false);
    expect(h.rpcRunning()).toBe(0);
    h.calls.length = 0;
    await h.controller.setEnabled(false);
    expect(h.calls.some((args) => args.includes("off"))).toBe(false);
  });

  it("refuses a mapping with Funnel on", async () => {
    const h = harness({
      serve: (port) =>
        JSON.stringify({
          ...JSON.parse(ours(port)),
          AllowFunnel: { "mac.tail1234.ts.net:8443": true },
        }),
    });
    await h.controller.init();
    await h.controller.setEnabled(true);
    expect(h.last()).toMatchObject({ status: "error", problem: "funnel" });
  });

  it("explains a missing app, a stopped tailnet and disabled HTTPS without running serve", async () => {
    for (const [options, problem] of [
      [{ installed: false }, "notInstalled"],
      [{ status: JSON.stringify({ BackendState: "Stopped" }) }, "notRunning"],
      [{ status: STATUS.replace('"CertDomains":["mac.tail1234.ts.net"],', "") }, "httpsDisabled"],
    ] as const) {
      const h = harness(options);
      await h.controller.init();
      await h.controller.setEnabled(true);
      expect(h.last(), problem).toMatchObject({ status: "error", problem });
      expect(h.calls.some((args) => args[0] === "serve" && args[1] !== "status")).toBe(false);
    }
  });

  it("reports a failed serve command and stops the local server", async () => {
    const h = harness({ failServeOn: true });
    await h.controller.init();
    await h.controller.setEnabled(true);
    expect(h.last()).toMatchObject({ status: "error", problem: "serveFailed" });
    expect(h.rpcRunning()).toBe(0);
  });

  it("resumes on launch when it was left on, and keeps an emptied allowlist empty", async () => {
    const h = harness({ settings: { enabled: true, ownerSeeded: true, allowlist: [] } });
    await h.controller.init();
    expect(h.last()).toMatchObject({ status: "on", allowlist: [] });
    await h.controller.setAllowlist(["friend@example.com"]);
    expect(h.stored().allowlist).toEqual(["friend@example.com"]);
    await expect(h.controller.setAllowlist(["not a login"])).rejects.toMatchObject({
      _tag: "InvalidInput",
    });
    await h.controller.dispose();
  });

  it("publishes a Tailscale Service on 443 when a service name is set", async () => {
    const h = harness({ settings: { service: "svc:openmail" } });
    await h.controller.init();
    await h.controller.setEnabled(true);
    const port = h.stored().port;
    expect(h.calls.at(-1)).toEqual([
      "serve",
      "--service=svc:openmail",
      "--bg",
      "--https=443",
      `http://127.0.0.1:${port}`,
    ]);
    expect(h.last()?.url).toBe("https://openmail.tail1234.ts.net");
    await h.controller.dispose();
  });

  it("removes its mapping at quit and publishes again on the next launch", async () => {
    const first = harness({ serve: ours });
    await first.controller.init();
    await first.controller.setEnabled(true);
    const port = first.stored().port;
    first.calls.length = 0;
    await first.controller.dispose();
    expect(first.calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--https=8443", "off"],
    ]);
    expect(first.rpcRunning()).toBe(0);
    expect(first.stored().enabled).toBe(true);

    const next = harness({ settings: first.stored() });
    await next.controller.init();
    expect(next.calls.at(-1)).toEqual([
      "serve",
      "--bg",
      "--https=8443",
      `http://127.0.0.1:${port}`,
    ]);
    expect(next.last()).toMatchObject({ status: "on" });
    await next.controller.dispose();
  });

  /** Signs a browser in through the local server and opens its RPC socket. */
  const openBrowser = async (port: number) => {
    const headers = { host: "mac.tail1234.ts.net:8443", "tailscale-user-login": "owner@github" };
    const cookie = await new Promise<string>((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
        res.resume();
        resolve((res.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "");
      })
        .on("error", reject)
        .end();
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
      headers: { ...headers, origin: "https://mac.tail1234.ts.net:8443", cookie },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return {
      closed: new Promise<number>((resolve) => {
        socket.once("close", resolve);
      }),
    };
  };

  it("lets phones reconnect after a quit, and ends their sessions when turned off", async () => {
    const quit = harness({ serve: ours });
    await quit.controller.init();
    await quit.controller.setEnabled(true);
    const going = await openBrowser(quit.stored().port);
    await quit.controller.dispose();
    expect(await going.closed).toBe(1001);

    const off = harness({ serve: ours });
    await off.controller.init();
    await off.controller.setEnabled(true);
    const ending = await openBrowser(off.stored().port);
    await off.controller.setEnabled(false);
    expect(await ending.closed).toBe(4401);
  });

  it("quits within the timeout when the Tailscale CLI hangs", async () => {
    const h = harness({ serve: ours });
    await h.controller.init();
    await h.controller.setEnabled(true);
    h.hang();
    const started = performance.now();
    await h.controller.dispose();
    expect(performance.now() - started).toBeLessThan(scaledMs(1000));
    expect(h.rpcRunning()).toBe(0);
  });

  it("reports a mapping it couldn't remove and removes it once Tailscale answers", async () => {
    const h = harness({ serve: ours });
    await h.controller.init();
    await h.controller.setEnabled(true);
    h.tailscaleDown(true);
    await h.controller.setEnabled(false);
    // Not "off": the mapping may still send tailnet traffic to a port nothing owns.
    expect(h.last()).toMatchObject({
      enabled: false,
      status: "error",
      problem: "removeFailed",
      url: null,
    });
    expect(h.rpcRunning()).toBe(0);
    h.tailscaleDown(false);
    h.calls.length = 0;
    await h.controller.refresh();
    expect(h.calls.slice(0, 2)).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--https=8443", "off"],
    ]);
    expect(h.last()).toMatchObject({ enabled: false, status: "off", problem: null });
    await h.controller.dispose();
  });

  it("keeps retrying a mapping it couldn't remove without being asked", async () => {
    const h = harness({ serve: ours });
    await h.controller.init();
    await h.controller.setEnabled(true);
    h.tailscaleDown(true);
    await h.controller.setEnabled(false);
    h.calls.length = 0;
    h.tailscaleDown(false);
    await expect
      .poll(() => h.calls.some((args) => args.join(" ") === "serve --https=8443 off"), waitLimit)
      .toBe(true);
    await expect.poll(() => h.last()?.status, waitLimit).toBe("off");
    await h.controller.dispose();
  });

  it("removes its own mapping left by a crash when launched with remote access off", async () => {
    const h = harness({ serve: ours, settings: { enabled: false, port: 45_678 } });
    await h.controller.init();
    expect(h.calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--https=8443", "off"],
    ]);
    expect(h.last()).toMatchObject({ status: "off", problem: null });
    expect(h.rpcRunning()).toBe(0);
  });

  it("leaves another app's mapping alone at launch", async () => {
    const h = harness({ serve: () => ours(3000), settings: { enabled: false, port: 45_678 } });
    await h.controller.init();
    expect(h.calls).toEqual([["serve", "status", "--json"]]);
    expect(h.last()).toMatchObject({ status: "off" });
  });

  it("tries a crash's mapping once at launch, then only on Refresh, and forgets the port once it's gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({ serve: ours, settings: { enabled: false, port: 45_678 } });
      h.tailscaleDown(true);
      await h.controller.init();
      // Unknown whether a mapping exists: stay quiet and don't poll a stopped Tailscale.
      expect(h.last()).toMatchObject({ status: "off", problem: null });
      expect(h.calls).toEqual([["serve", "status", "--json"]]);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(h.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      h.tailscaleDown(false);
      await h.controller.refresh();
      expect(h.calls).toContainEqual(["serve", "--https=8443", "off"]);
      expect(h.stored().port).toBe(0);

      // The next launch with the setting off runs no Tailscale command.
      const next = harness({ serve: ours, settings: h.stored() });
      await next.controller.init();
      expect(next.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off retrying a mapping a turn-off left behind and stops when the status changes", async () => {
    const h = harness({ serve: ours, retryMs: 1000, retryMaxMs: 4000 });
    await h.controller.init();
    await h.controller.setEnabled(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.tailscaleDown(true);
      await h.controller.setEnabled(false);
      expect(h.last()).toMatchObject({ status: "error", problem: "removeFailed" });
      const sweeps = () =>
        h.calls.filter((args) => args.join(" ") === "serve status --json").length;
      const before = sweeps();
      // Retries at 1 s, then 2 s, 4 s, 4 s later: 1, 3, 7 and 11 s.
      const counts: number[] = [];
      for (const at of [999, 1, 1999, 1, 3999, 1, 3999, 1]) {
        await vi.advanceTimersByTimeAsync(at);
        counts.push(sweeps() - before);
      }
      expect(counts).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);

      // Turning it on again changes the status; the pending retry stops there.
      await h.controller.setEnabled(true);
      expect(h.last()).toMatchObject({ status: "error", problem: "notRunning" });
      const after = h.calls.length;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(h.calls).toHaveLength(after);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await h.controller.dispose();
  });

  it("forgets the stored port after a clean turn-off", async () => {
    const h = harness({ serve: ours });
    await h.controller.init();
    await h.controller.setEnabled(true);
    expect(h.stored().port).toBeGreaterThan(0);
    await h.controller.setEnabled(false);
    expect(h.stored()).toMatchObject({ enabled: false, port: 0 });
  });

  it("keeps the stored port when the Tailscale CLI can't be found to check the mapping", async () => {
    const h = harness({ serve: ours, settings: { enabled: false, port: 45_678 } });
    h.setInstalled(false);
    await h.controller.init();
    // Nothing was checked, so nothing is forgotten.
    expect(h.calls).toEqual([]);
    expect(h.stored().port).toBe(45_678);
    expect(h.last()).toMatchObject({ status: "off", problem: null });

    h.setInstalled(true);
    await h.controller.refresh();
    expect(h.calls).toContainEqual(["serve", "--https=8443", "off"]);
    expect(h.stored().port).toBe(0);
  });

  it("keeps the stored port after a turn-off without the Tailscale CLI", async () => {
    const h = harness({ serve: ours });
    await h.controller.init();
    await h.controller.setEnabled(true);
    const port = h.stored().port;
    h.setInstalled(false);
    h.calls.length = 0;
    await h.controller.setEnabled(false);
    expect(h.calls).toEqual([]);
    expect(h.stored()).toMatchObject({ enabled: false, port });
    expect(h.last()).toMatchObject({ status: "off", problem: null });

    // The next launch finds the CLI again and removes the mapping it left.
    const next = harness({ serve: ours, settings: h.stored() });
    await next.controller.init();
    expect(next.calls).toContainEqual(["serve", "--https=8443", "off"]);
    expect(next.stored().port).toBe(0);
  });
});
