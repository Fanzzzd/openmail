import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMPOSE_ATTACHMENT_LIMIT } from "@openmail/core/schema";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkRequest,
  createSessions,
  decodeName,
  MAX_SESSIONS,
  type GateConfig,
} from "./remote-auth";
import { contentDisposition, parsePartPath, startRemoteServer, WEB_CSP } from "./remote-server";

const HOST = "mac.tail1234.ts.net";
const config: GateConfig = { allowlist: ["Owner@github"], host: HOST, port: 8443 };
const ORIGIN = `https://${HOST}:8443`;
const tailnet = (login = "owner@github") => ({
  host: `${HOST}:8443`,
  "tailscale-user-login": login,
  "tailscale-user-name": "=?utf-8?q?Ren=C3=A9?=",
});

describe("identity gate", () => {
  const facts = (headers: IncomingHttpHeaders, remoteAddress = "127.0.0.1") => ({
    remoteAddress,
    headers,
  });
  it("accepts an allowlisted tailnet login on the tailnet host", () => {
    expect(checkRequest(facts(tailnet()), config)).toEqual({
      ok: true,
      login: "owner@github",
      name: "René",
    });
  });
  it.each([
    ["no identity header (plain local request)", { host: `${HOST}:8443` }, "no-identity", 403],
    ["wrong login", tailnet("intruder@github"), "not-allowed", 403],
    ["bad Host (DNS rebinding)", { ...tailnet(), host: "evil.example:8443" }, "bad-host", 421],
    ["Host without the serve port", { ...tailnet(), host: HOST }, "bad-host", 421],
    [
      "Funnel request without identity",
      { host: `${HOST}:8443`, "tailscale-funnel-request": "?1" },
      "funnel",
      403,
    ],
    [
      "Funnel request with a forged identity",
      { ...tailnet(), "tailscale-funnel-request": "?1" },
      "funnel",
      403,
    ],
    ["login with spaces", tailnet("owner@github extra"), "no-identity", 403],
  ] as const)("refuses %s", (_, headers, reason, status) => {
    expect(checkRequest(facts(headers), config)).toEqual({ ok: false, status, reason });
  });
  it("refuses anything that did not come through loopback", () => {
    expect(checkRequest(facts(tailnet(), "100.64.0.2"), config)).toMatchObject({
      ok: false,
      reason: "not-loopback",
    });
    expect(checkRequest(facts(tailnet(), "::1"), config).ok).toBe(true);
  });
  it("decodes Serve's encoded display names", () => {
    expect(decodeName("=?utf-8?q?Ren=C3=A9_F?=", "x")).toBe("René F");
    expect(decodeName(undefined, "fallback")).toBe("fallback");
  });
});

describe("sessions", () => {
  it("binds a signed, expiring cookie to one login", () => {
    let now = 1_000;
    const sessions = createSessions(() => now);
    const cookie = sessions.issue("owner@github", "Owner");
    expect(cookie).toMatch(
      /^__Host-openmail-session=[\w-]+\.[\w-]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/,
    );
    const header = cookie.split(";")[0];
    expect(sessions.find(header, "OWNER@github")).toBeDefined();
    expect(sessions.find(header, "other@github")).toBeNull();
    expect(sessions.find(`${header}x`, "owner@github")).toBeNull();
    now += 12 * 60 * 60 * 1000;
    expect(sessions.find(header, "owner@github")).toBeNull();
  });
  const connected = (sessions: ReturnType<typeof createSessions>, cookie: string) => {
    const session = sessions.find(cookie.split(";")[0], "owner@github");
    if (!session) throw new Error("no session");
    const closed: number[] = [];
    sessions.attach(session, { close: (code) => closed.push(code ?? 0) });
    return { id: session.id, closed };
  };
  it("disconnects a session and closes its sockets", () => {
    const sessions = createSessions();
    const { id, closed } = connected(sessions, sessions.issue("owner@github", "Owner"));
    expect(sessions.list()).toMatchObject([{ id, connected: true }]);
    sessions.disconnect(id);
    expect(closed).toEqual([4401]);
    expect(sessions.list()).toEqual([]);
  });
  it("sweeps expired sessions and closes their sockets", () => {
    let now = 1_000;
    const sessions = createSessions(() => now);
    const { closed } = connected(sessions, sessions.issue("owner@github", "Owner"));
    sessions.sweep();
    expect(closed).toEqual([]);
    now += 12 * 60 * 60 * 1000;
    sessions.sweep();
    expect(closed).toEqual([4401]);
    expect(sessions.list()).toEqual([]);
  });
  it("keeps at most MAX_SESSIONS, ending the oldest first", () => {
    let now = 1_000;
    const sessions = createSessions(() => now);
    const { id: first, closed } = connected(sessions, sessions.issue("owner@github", "Owner"));
    for (let i = 1; i < MAX_SESSIONS; i++) {
      now += 1;
      sessions.issue("owner@github", "Owner");
    }
    expect(sessions.list()).toHaveLength(MAX_SESSIONS);
    sessions.issue("owner@github", "Owner");
    expect(sessions.list()).toHaveLength(MAX_SESSIONS);
    expect(sessions.list().some((session) => session.id === first)).toBe(false);
    expect(closed).toEqual([4401]);
  });
  it("ends sessions whose login leaves the allowlist", () => {
    const sessions = createSessions();
    sessions.issue("owner@github", "Owner");
    sessions.issue("friend@example.com", "Friend");
    sessions.retain(["owner@github"]);
    expect(sessions.list().map((session) => session.login)).toEqual(["owner@github"]);
  });
});

describe("helpers", () => {
  it("parses part paths strictly and builds safe dispositions", () => {
    expect(parsePartPath("0")).toEqual([0]);
    expect(parsePartPath("2.1")).toEqual([2, 1]);
    for (const bad of [null, "", "a", "-1", "1..2", "1.2.3.4.5.6.7.8.9", "99999"])
      expect(parsePartPath(bad), String(bad)).toBeNull();
    expect(contentDisposition('ré"port\r\n.pdf')).toBe(
      `attachment; filename="r__port__.pdf"; filename*=UTF-8''r%C3%A9%22port__.pdf`,
    );
  });
});

describe("remote server", () => {
  let base: string;
  let root: string;
  let server: Awaited<ReturnType<typeof startRemoteServer>>;
  const sessions = createSessions();
  const connections: string[] = [];
  const blob = new Uint8Array(600 * 1024).fill(7);

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "openmail-web-"));
    root = path.join(base, "web");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "web.html"), "<!doctype html><title>OpenMail</title>");
    await writeFile(path.join(root, "assets", "app.js"), "export {}");
    await writeFile(path.join(base, "openmail-outside.txt"), "secret");
    server = await startRemoteServer({
      webRoot: root,
      port: 0,
      gate: () => config,
      sessions,
      attachment: async (messageId, part) => {
        if (messageId !== "m1" || part.join(".") !== "0.1") throw new Error("missing");
        return { filename: "report.html", data: blob };
      },
      provider: async (accountId) => (accountId === "gmail-account" ? "gmail" : null),
      onConnection: (connection) => ({
        message: (frame) => {
          connections.push(frame);
          connection.send(frame);
        },
        closed: () => connections.push("closed"),
      }),
    });
  });
  afterAll(async () => {
    await server.close();
    await rm(base, { recursive: true, force: true });
  });

  const call = (pathname: string, headers: Record<string, string>, method = "GET", body?: Buffer) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: server.port, path: pathname, method, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      },
    );
  const signIn = async () => {
    const page = await call("/", tailnet());
    const cookie = (page.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    return cookie;
  };

  it("serves the app with strict headers and a session cookie to an allowed login", async () => {
    const page = await call("/mail/all/inbox", tailnet());
    expect(page.status).toBe(200);
    expect(page.body.toString()).toContain("OpenMail");
    expect(page.headers["content-security-policy"]).toBe(WEB_CSP);
    expect(WEB_CSP).toContain("connect-src 'self'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["set-cookie"]?.[0]).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const asset = await call("/assets/app.js", tailnet());
    expect(asset.headers["content-type"]).toMatch(/javascript/);
    expect(asset.headers["set-cookie"]).toBeUndefined();
  });

  it("starts sessions only for the app document", async () => {
    const before = sessions.list().length;
    for (const pathname of ["/assets/app.js", "/assets/missing.js", "/favicon.ico", "/x.png"])
      expect((await call(pathname, tailnet())).headers["set-cookie"], pathname).toBeUndefined();
    expect(sessions.list()).toHaveLength(before);
    const cookie = await signIn();
    expect(cookie).toMatch(/^__Host-openmail-session=/);
    // A page load with a live session keeps it.
    const again = await call("/mail/all/inbox", { ...tailnet(), cookie });
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("applies the auth matrix to real requests", async () => {
    expect((await call("/", { host: `${HOST}:8443` })).status).toBe(403);
    expect((await call("/", tailnet("intruder@github"))).status).toBe(403);
    expect((await call("/", { ...tailnet(), host: "127.0.0.1" })).status).toBe(421);
    expect(
      (await call("/", { host: `${HOST}:8443`, "tailscale-funnel-request": "?1" })).status,
    ).toBe(403);
    expect((await call("/", {})).status).toBe(403);
    expect((await call("/", tailnet(), "POST")).status).toBe(405);
  });

  it("never serves files outside the web build", async () => {
    for (const pathname of [
      "/../openmail-outside.txt",
      "/%2e%2e/openmail-outside.txt",
      "/assets/../../x.js",
    ])
      expect((await call(pathname, tailnet())).status, pathname).not.toBe(200);
  });

  it("downloads attachments by id only with a session, as an octet-stream download", async () => {
    expect((await call("/api/attachment?message=m1&part=0.1", tailnet())).status).toBe(401);
    const cookie = await signIn();
    const file = await call("/api/attachment?message=m1&part=0.1", { ...tailnet(), cookie });
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/octet-stream");
    expect(file.headers["content-disposition"]).toBe(
      `attachment; filename="report.html"; filename*=UTF-8''report.html`,
    );
    expect(file.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(file.body.equals(Buffer.from(blob))).toBe(true);
    expect((await call("/api/attachment?message=m1&part=9", { ...tailnet(), cookie })).status).toBe(
      404,
    );
    expect((await call("/api/attachment?message=m1&part=x", { ...tailnet(), cookie })).status).toBe(
      400,
    );
    // A session belongs to its login.
    expect(
      (await call("/api/attachment?message=m1&part=0.1", { ...tailnet("Owner@GitHub"), cookie }))
        .status,
    ).toBe(200);
  });

  const multipart = (files: { name: string; type: string; data: Buffer }[], extra = "") => {
    const boundary = "----openmailtest";
    const parts = files.map((file) =>
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
        ),
        file.data,
        Buffer.from("\r\n"),
      ]),
    );
    return {
      type: `multipart/form-data; boundary=${boundary}`,
      body: Buffer.concat([...parts, Buffer.from(`${extra}--${boundary}--\r\n`)]),
    };
  };

  it("accepts compose uploads within the desktop limits", async () => {
    const cookie = await signIn();
    const upload = multipart([
      { name: "note.txt", type: "text/plain", data: Buffer.from("hello") },
    ]);
    const headers = { ...tailnet(), cookie, origin: ORIGIN, "content-type": upload.type };
    const ok = await call("/api/upload?account=gmail-account", headers, "POST", upload.body);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.toString())).toEqual({
      files: [{ filename: "note.txt", mimeType: "text/plain", content: "aGVsbG8=" }],
    });

    const blocked = multipart([
      { name: "setup.exe", type: "application/octet-stream", data: Buffer.from("MZ") },
    ]);
    const exe = await call(
      "/api/upload?account=gmail-account",
      { ...headers, "content-type": blocked.type },
      "POST",
      blocked.body,
    );
    expect(exe.status).toBe(415);
    expect(JSON.parse(exe.body.toString())).toEqual({
      error: "gmailBlocked",
      filename: "setup.exe",
    });

    const big = multipart([
      {
        name: "a.bin",
        type: "application/octet-stream",
        data: Buffer.alloc(COMPOSE_ATTACHMENT_LIMIT / 2 + 1),
      },
      {
        name: "b.bin",
        type: "application/octet-stream",
        data: Buffer.alloc(COMPOSE_ATTACHMENT_LIMIT / 2 + 1),
      },
    ]);
    const tooLarge = await call(
      "/api/upload?account=gmail-account",
      { ...headers, "content-type": big.type },
      "POST",
      big.body,
    );
    expect(tooLarge.status).toBe(413);
  });

  it("requires a known account, so the blocked-type check always runs", async () => {
    const cookie = await signIn();
    const upload = multipart([{ name: "setup.exe", type: "text/plain", data: Buffer.from("MZ") }]);
    const headers = { ...tailnet(), cookie, origin: ORIGIN, "content-type": upload.type };
    expect((await call("/api/upload", headers, "POST", upload.body)).status).toBe(400);
    expect((await call("/api/upload?account=nope", headers, "POST", upload.body)).status).toBe(400);
  });

  it("refuses uploads without a length and more than two at once", async () => {
    const cookie = await signIn();
    const upload = multipart([{ name: "a.txt", type: "text/plain", data: Buffer.from("x") }]);
    const headers = { ...tailnet(), cookie, origin: ORIGIN, "content-type": upload.type };
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/upload?account=gmail-account",
          method: "POST",
          headers: { ...headers, "transfer-encoding": "chunked" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(upload.body);
    });
    expect(chunked).toBe(411);
    // Two uploads that never finish their bodies hold both slots.
    const held = [0, 1].map(() => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: "/api/upload?account=gmail-account",
        method: "POST",
        headers: { ...headers, "content-length": String(upload.body.length) },
      });
      req.on("error", () => null);
      req.write(upload.body.subarray(0, 10));
      return req;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    const busy = await call("/api/upload?account=gmail-account", headers, "POST", upload.body);
    expect(busy.status).toBe(503);
    for (const req of held) req.destroy();
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(
      (await call("/api/upload?account=gmail-account", headers, "POST", upload.body)).status,
    ).toBe(200);
  });

  it("refuses uploads with another origin, no session or another content type", async () => {
    const cookie = await signIn();
    const upload = multipart([{ name: "a.txt", type: "text/plain", data: Buffer.from("x") }]);
    const base = { ...tailnet(), "content-type": upload.type };
    expect(
      (
        await call(
          "/api/upload",
          { ...base, cookie, origin: "https://evil.example" },
          "POST",
          upload.body,
        )
      ).status,
    ).toBe(403);
    expect((await call("/api/upload", { ...base, cookie }, "POST", upload.body)).status).toBe(403);
    expect(
      (await call("/api/upload", { ...base, origin: ORIGIN }, "POST", upload.body)).status,
    ).toBe(401);
    expect(
      (
        await call(
          "/api/upload",
          { ...base, cookie, origin: ORIGIN, "content-type": "text/plain" },
          "POST",
          Buffer.from("x"),
        )
      ).status,
    ).toBe(415);
  });

  const open = (headers: Record<string, string>) =>
    new Promise<{ status: number; socket?: WebSocket }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, { headers });
      socket.once("open", () => resolve({ status: 101, socket }));
      socket.once("unexpected-response", (_, res) => resolve({ status: res.statusCode ?? 0 }));
      socket.once("error", () => resolve({ status: 0 }));
    });

  it("upgrades the RPC socket only for the right origin, login and session", async () => {
    const cookie = await signIn();
    const good = { ...tailnet(), cookie, origin: ORIGIN };
    expect((await open({ ...good, origin: "https://evil.example" })).status).toBe(403);
    expect((await open({ ...good, origin: `http://${HOST}:8443` })).status).toBe(403);
    expect((await open({ ...tailnet(), origin: ORIGIN })).status).toBe(401);
    expect((await open({ ...good, "tailscale-user-login": "intruder@github" })).status).toBe(403);
    expect((await open({ ...good, host: "localhost:8443" })).status).toBe(421);
    const accepted = await open(good);
    expect(accepted.status).toBe(101);
    const echoed = new Promise<string>((resolve) => {
      accepted.socket?.once("message", (data: Buffer) => resolve(data.toString("utf8")));
    });
    accepted.socket?.send('{"_tag":"Ping"}');
    expect(await echoed).toBe('{"_tag":"Ping"}');
    expect(sessions.list().some((session) => session.connected)).toBe(true);
    const closed = new Promise<number>((resolve) => {
      accepted.socket?.once("close", resolve);
    });
    for (const session of sessions.list()) if (session.connected) sessions.disconnect(session.id);
    expect(await closed).toBe(4401);
  });
});
