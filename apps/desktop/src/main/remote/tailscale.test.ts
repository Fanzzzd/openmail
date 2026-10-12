import { describe, expect, it } from "vitest";
import {
  checkServe,
  findTailscale,
  localTailscale,
  parseStatus,
  publicUrl,
  sessionTailscale,
  SERVE_STATUS_ARGS,
  serveOffArgs,
  serveOnArgs,
  STATUS_ARGS,
  tailscaleCandidates,
} from "./tailscale";

const STATUS = JSON.stringify({
  BackendState: "Running",
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: {
    Name: "owner.github",
    MagicDNSSuffix: "tail1234.ts.net",
    MagicDNSEnabled: true,
  },
  CertDomains: ["mac.tail1234.ts.net"],
  Self: { DNSName: "Mac.tail1234.ts.net.", UserID: 3207143247423768, HostName: "Mac" },
  User: {
    "3207143247423768": { ID: 3207143247423768, LoginName: "Owner@github", DisplayName: "Owner" },
    "1": { ID: 1, LoginName: "someone@example.com" },
  },
});

describe("tailscale status", () => {
  it("reads this Mac's owner login, names and HTTPS support", () => {
    const state = parseStatus(STATUS);
    expect(state).toEqual({
      installed: true,
      running: true,
      tailnet: "owner.github",
      dnsName: "mac.tail1234.ts.net",
      suffix: "tail1234.ts.net",
      login: "Owner@github",
      https: true,
    });
    expect(publicUrl(state, "")).toBe("https://mac.tail1234.ts.net:8443");
    expect(publicUrl(state, "svc:openmail")).toBe("https://openmail.tail1234.ts.net");
  });

  it("reports a stopped backend, missing certificates and unreadable output", () => {
    const stopped = parseStatus(
      JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "" }, CertDomains: null }),
    );
    expect(stopped).toMatchObject({ installed: true, running: false, https: false, login: null });
    expect(parseStatus("not json")).toMatchObject({ installed: true, running: false });
  });
});

describe("serve commands", () => {
  it("builds the exact argv for a node port and for a Tailscale Service", () => {
    expect(STATUS_ARGS).toEqual(["status", "--json"]);
    expect(SERVE_STATUS_ARGS).toEqual(["serve", "status", "--json"]);
    expect(serveOnArgs({ port: 53111, service: "" })).toEqual([
      "serve",
      "--bg",
      "--https=8443",
      "http://127.0.0.1:53111",
    ]);
    expect(serveOffArgs({ service: "" })).toEqual(["serve", "--https=8443", "off"]);
    expect(serveOnArgs({ port: 53111, service: "svc:openmail" })).toEqual([
      "serve",
      "--service=svc:openmail",
      "--bg",
      "--https=443",
      "http://127.0.0.1:53111",
    ]);
    expect(serveOffArgs({ service: "svc:openmail" })).toEqual([
      "serve",
      "--service=svc:openmail",
      "--https=443",
      "off",
    ]);
  });

  it("never builds a Funnel command and refuses bad ports", () => {
    for (const args of [
      serveOnArgs({ port: 1, service: "" }),
      serveOnArgs({ port: 65535, service: "svc:openmail" }),
      serveOffArgs({ service: "" }),
    ])
      expect(args.join(" ")).not.toMatch(/funnel/i);
    expect(() => serveOnArgs({ port: 0, service: "" })).toThrow();
    expect(() => serveOnArgs({ port: 70000, service: "" })).toThrow();
  });
});

const host = "mac.tail1234.ts.net";
const mapping = (proxy: string, extra: object = {}) =>
  JSON.stringify({
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
      [`${host}:8443`]: { Handlers: { "/": { Proxy: proxy } } },
    },
    ...extra,
  });

describe("serve conflicts", () => {
  const target = { port: 53111, service: "" };

  it("treats an empty config or other ports as free", () => {
    expect(checkServe("{}", target)).toEqual({ kind: "free" });
    expect(checkServe("", target)).toEqual({ kind: "free" });
    expect(
      checkServe(
        JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
        }),
        target,
      ),
    ).toEqual({ kind: "free" });
  });

  it("recognises its own mapping, including the localhost spelling", () => {
    expect(checkServe(mapping("http://127.0.0.1:53111"), target)).toEqual({ kind: "ours" });
    expect(checkServe(mapping("localhost:53111"), target)).toEqual({ kind: "ours" });
    expect(
      checkServe(mapping("http://127.0.0.1:41000"), { ...target, previousPort: 41000 }),
    ).toEqual({ kind: "stale" });
  });

  it("refuses to overwrite someone else's mapping on 8443", () => {
    expect(checkServe(mapping("http://127.0.0.1:3000"), target)).toEqual({
      kind: "conflict",
      reason: "handlers",
    });
    expect(
      checkServe(
        JSON.stringify({
          TCP: { "8443": { HTTPS: true } },
          Web: {
            [`${host}:8443`]: {
              Handlers: { "/": { Proxy: "http://127.0.0.1:53111" }, "/grafana": { Proxy: "x" } },
            },
          },
        }),
        target,
      ),
    ).toEqual({ kind: "conflict", reason: "handlers" });
    expect(
      checkServe(JSON.stringify({ TCP: { "8443": { TCPForward: "127.0.0.1:22" } } }), target),
    ).toEqual({ kind: "conflict", reason: "tcp" });
    expect(
      checkServe(
        JSON.stringify({
          Foreground: { abc: { TCP: { "8443": { HTTPS: true } } } },
        }),
        target,
      ),
    ).toEqual({ kind: "conflict", reason: "foreground" });
    expect(checkServe("{broken", target)).toEqual({ kind: "conflict", reason: "port" });
  });

  it("refuses a mapping that has Funnel turned on, even when it is OpenMail's", () => {
    expect(
      checkServe(
        mapping("http://127.0.0.1:53111", { AllowFunnel: { [`${host}:8443`]: true } }),
        target,
      ),
    ).toEqual({ kind: "conflict", reason: "funnel" });
  });

  it("checks a Tailscale Service's own config", () => {
    const service = { port: 53111, service: "svc:openmail" };
    const config = (proxy: string) =>
      JSON.stringify({
        Services: {
          "svc:openmail": {
            TCP: { "443": { HTTPS: true } },
            Web: { "openmail.tail1234.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
          },
        },
      });
    expect(checkServe("{}", service)).toEqual({ kind: "free" });
    expect(checkServe(config("http://127.0.0.1:53111"), service)).toEqual({ kind: "ours" });
    expect(checkServe(config("http://127.0.0.1:9999"), service)).toEqual({
      kind: "conflict",
      reason: "handlers",
    });
  });
});

describe("finding the Tailscale CLI", () => {
  it("tries the app first, then Homebrew and standalone installs, then absolute PATH entries", () => {
    expect(tailscaleCandidates("/usr/local/bin:relative/bin:/Users/me/bin")).toEqual([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/Users/me/bin/tailscale",
    ]);
  });

  it("uses a Homebrew CLI when the app isn't installed", async () => {
    const present = new Set(["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]);
    expect(await findTailscale(tailscaleCandidates(""), async (file) => present.has(file))).toBe(
      "/opt/homebrew/bin/tailscale",
    );
    expect(await findTailscale(tailscaleCandidates(""), async () => false)).toBeNull();
  });

  it("reports no CLI as not installed and runs nothing", async () => {
    const tailscale = localTailscale(async () => null);
    expect(await tailscale.installed()).toBe(false);
    expect(await tailscale.runCli(STATUS_ARGS)).toEqual({ code: 127, stdout: "" });
  });

  it("runs the CLI it found with a fixed argv", async () => {
    // /bin/echo stands in for the CLI: it prints the argv it was given.
    const tailscale = localTailscale(async () => "/bin/echo");
    expect(await tailscale.installed()).toBe(true);
    expect(await tailscale.runCli(["status", "--json"])).toEqual({
      code: 0,
      stdout: "status --json\n",
    });
  });

  it("never runs Tailscale in a read-only session such as smoke", async () => {
    const tailscale = sessionTailscale({ OPENMAIL_READ_ONLY: "1", PATH: "/bin" });
    expect(await tailscale.installed()).toBe(false);
    expect(await tailscale.runCli(["serve", "--https=8443", "off"])).toEqual({
      code: 127,
      stdout: "",
    });
  });
});
