import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_REMOTE_ACCESS,
  normalizeRemoteAccess,
  type RemoteAccessSettings,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RemoteAccessView } from "../../shared/remote-access";
import { createRemoteAccess, type RemoteAccessDeps } from "./remote-access";
import type { CliResult } from "./tailscale";

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
}) {
  let stored: RemoteAccessSettings = { ...DEFAULT_REMOTE_ACCESS, ...options.settings };
  const calls: string[][] = [];
  let rpcRunning = 0;
  let port = 0;
  const deps: RemoteAccessDeps = {
    mailbox: {
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
      attachmentPart: () => Effect.die("unused"),
      accounts: Effect.succeed([]),
    },
    installed: async () => options.installed ?? true,
    runCli: async (args): Promise<CliResult> => {
      calls.push([...args]);
      if (args[0] === "status") return { code: 0, stdout: options.status ?? STATUS };
      if (args.join(" ") === "serve status --json")
        return { code: 0, stdout: options.serve?.(port) ?? "{}" };
      if (args.at(-1)?.startsWith("http://") && options.failServeOn) return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    },
    webRoot: root,
    startRpc: () => {
      rpcRunning++;
      return async () => {
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
});
