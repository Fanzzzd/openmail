import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { getCurrentFuseWire, FuseState, FuseV1Options } from "@electron/fuses";
import { expect, it, vi } from "vitest";
import {
  APP_CSP,
  APP_PAGE,
  developmentPage,
  isAppPage,
  validOpenFile,
  WINDOW_SECURITY,
} from "./security-policy";
import { configurePermissions } from "./security";
import { appResource, appResourceHandler } from "./app-protocol";
import { externalUrl } from "../shared/external-url";
import { parseAppLink } from "../../../../packages/core/src/system.js";
import { Schema } from "effect";

it("rejects OS schemes, malformed and oversized external URLs and strips browser credentials", () => {
  expect(externalUrl("https://trusted:secret@evil.example/path")).toBe("https://evil.example/path");
  expect(externalUrl("http://example.com:8080/a")).toBe("http://example.com:8080/a");
  expect(externalUrl("mailto:a+tag@example.com?subject=Hello%20world")).toBe(
    "mailto:a+tag@example.com?subject=Hello%20world",
  );
  expect(
    externalUrl(
      "mailto:a@example.com?body=one%0D%0Atwo&subject=A+B&attachment=file:///private&from=attacker",
    ),
  ).toBe(
    "mailto:a@example.com?body=one%0D%0Atwo&subject=A+B&attachment=file:///private&from=attacker",
  );
  for (const value of [
    null,
    {},
    "",
    "https://",
    "https://ex\nample.com",
    "file:///etc/passwd",
    "smb://host/share",
    "openmail://message/id",
    "x-apple.systempreferences:any",
    "javascript:alert(1)",
    "mailto://evil/a",
    `https://example.com/${"a".repeat(100_000)}`,
  ])
    expect(externalUrl(value)).toBeNull();
});

it("pins app origins and entry paths, ignoring renderer environment URLs in packaged builds", () => {
  expect(developmentPage(true, "http://localhost:5173/")).toBeNull();
  expect(developmentPage(false, "http://localhost:5173/")).toBe("http://localhost:5173/");
  for (const value of [
    "https://evil.example/",
    "file:///tmp/app.html",
    "http://user@localhost:5173/",
    "http://localhost:5173/other",
  ])
    expect(developmentPage(false, value)).toBeNull();
  expect(isAppPage(`${APP_PAGE}?thread=id#reader`, null)).toBe(true);
  for (const url of [
    "file:///tmp/index.html",
    "about:srcdoc",
    "openmail-app://evil/index.html",
    "openmail-app://app/assets/other.html",
    "openmail-app://user@app/index.html",
    "https://evil.example/index.html",
  ])
    expect(isAppPage(url, null)).toBe(false);
  expect(isAppPage("http://localhost:5174/", "http://localhost:5173/")).toBe(false);
  expect(WINDOW_SECURITY).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
  });
});

it("denies request, check and device permissions including notifications handled natively", () => {
  const handlers = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  };
  configurePermissions(handlers);
  const request = handlers.setPermissionRequestHandler.mock.calls[0]?.[0];
  const check = handlers.setPermissionCheckHandler.mock.calls[0]?.[0];
  const device = handlers.setDevicePermissionHandler.mock.calls[0]?.[0];
  for (const permission of [
    "media",
    "geolocation",
    "midi",
    "hid",
    "serial",
    "usb",
    "notifications",
    "clipboard-read",
    "clipboard-sanitized-write",
    "unknown",
  ]) {
    const answer = vi.fn();
    request(null, permission, answer, { requestingUrl: APP_PAGE, isMainFrame: true });
    expect(answer).toHaveBeenCalledWith(false);
    expect(check(null, permission, APP_PAGE, { isMainFrame: true })).toBe(false);
    expect(device({ deviceType: permission, origin: APP_PAGE })).toBe(false);
  }
});

it("serves renderer assets with CSP and denies traversal, sibling paths and escaping symlinks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openmail-protocol-"));
  const root = path.join(directory, "renderer");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "index.html"), "<p>app</p>");
    await writeFile(path.join(directory, "secret.js"), "private");
    await symlink(path.join(directory, "secret.js"), path.join(root, "escape.js"));
    expect(await appResource(root, APP_PAGE)).toBe(await realpath(path.join(root, "index.html")));
    for (const url of [
      "openmail-app://app/../secret.js",
      "openmail-app://app/%2e%2e/secret.js",
      "openmail-app://app/%2e%2e%2fsecret.js",
      "openmail-app://app/%252e%252e/secret.js",
      "openmail-app://app/%5csecret.js",
      "openmail-app://app/escape.js",
      "openmail-app://app/package.json",
      "openmail-app://evil/index.html",
      "file:///etc/passwd",
    ])
      expect(await appResource(root, url)).toBeNull();
    const response = await appResourceHandler(root)(new Request(APP_PAGE));
    expect(await response.text()).toBe("<p>app</p>");
    expect(response.headers.get("Content-Security-Policy")).toBe(APP_CSP);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await appResourceHandler(root)(new Request(APP_PAGE, { method: "POST" }))).status).toBe(
      404,
    );
    const built = await readFile(new URL("../../out/renderer/index.html", import.meta.url), "utf8");
    expect(built).toContain(`content="${APP_CSP}"`);
    expect(built).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|\/src\/main.tsx/);
    expect(built).toMatch(/<script[^>]+src="\.\/assets\//);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("deep links and Dock paths reject oversized input, controls and malformed encodings without accepting actions", () => {
  for (const url of [
    "openmail://message/id?send=1",
    "openmail://message/../id",
    "openmail://message/%2e%2e/id",
    "openmail://message/%00",
    `openmail://message/${"a".repeat(100_000)}`,
    "mailto:a@example.com?body=%zz",
    "mailto:a@example.com?subject=%C0%AF",
    "mailto:a@example.com\n?subject=bad",
  ])
    expect(parseAppLink(url)).toBeNull();
  expect(
    parseAppLink("mailto:a@example.com?attachment=file%3A%2Fsecret&from=attacker&subject=Review"),
  ).toMatchObject({ kind: "compose", draft: { subject: "Review" } });
  expect(validOpenFile("/tmp/report%20literal.pdf")).toBe(true);
  for (const file of [
    "",
    "relative.pdf",
    "file:///tmp/private",
    "//server/share",
    "\\\\server\\share",
    "/tmp/\0secret",
    `/${"a".repeat(4096)}`,
  ])
    expect(validOpenFile(file)).toBe(false);
});

it("afterPack changes the real fuse wire before signing without starting Electron", async () => {
  const require = createRequire(import.meta.url);
  const config = Schema.decodeUnknownSync(
    Schema.Struct({ asar: Schema.Boolean, afterPack: Schema.Unknown }),
  )(require("../../electron-builder.config.cjs"));
  expect(config.asar).toBe(true);
  if (typeof config.afterPack !== "function") throw new Error("Missing afterPack hook");
  const directory = await mkdtemp(path.join(tmpdir(), "openmail-fuses-"));
  const filename = "OpenMail";
  const binary = path.join(directory, filename);
  try {
    await writeFile(
      binary,
      Buffer.concat([
        Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
        Buffer.from([1, 9]),
        Buffer.from("111111111"),
      ]),
    );
    await config.afterPack({
      appOutDir: directory,
      electronPlatformName: "linux",
      packager: { executableName: filename, appInfo: { productFilename: filename } },
    });
    const wire = await getCurrentFuseWire(binary);
    for (const fuse of [
      FuseV1Options.RunAsNode,
      FuseV1Options.EnableNodeOptionsEnvironmentVariable,
      FuseV1Options.EnableNodeCliInspectArguments,
      FuseV1Options.GrantFileProtocolExtraPrivileges,
    ])
      expect(wire[fuse]).toBe(FuseState.DISABLE);
    for (const fuse of [
      FuseV1Options.EnableCookieEncryption,
      FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
      FuseV1Options.OnlyLoadAppFromAsar,
    ])
      expect(wire[fuse]).toBe(FuseState.ENABLE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("the built preload exposes only the fixed RPC bridge to the top frame and renderer code needs no eval", async () => {
  const preload = await readFile(new URL("../../out/preload/index.cjs", import.meta.url), "utf8");
  expect([...preload.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])).toEqual([
    "electron",
  ]);
  expect(preload).toContain("if (process.isMainFrame)");
  expect(preload).toContain('exposeInMainWorld("openmailRpc", bridge)');
  expect(preload).not.toMatch(/ipcRenderer\.invoke|exposeInMainWorld\("(?:electron|ipcRenderer)"/);
  const assets = new URL("../../out/renderer/assets/", import.meta.url);
  for (const file of await readdir(assets)) {
    if (!file.endsWith(".js")) continue;
    expect(await readFile(new URL(file, assets), "utf8")).not.toMatch(
      /\beval\s*\(|\bnew Function\s*\(/,
    );
  }
});

it("hands legacy mailto URLs to the OS without applying the strict inbound parser", () => {
  for (const [raw, expected] of [
    ["mailto:a@example.com, b@example.com", "mailto:a@example.com,%20b@example.com"],
    ["mailto:a@example.com?subject=%E9", "mailto:a@example.com?subject=%E9"],
    ["mailto:a@example.com?subject=100% done", "mailto:a@example.com?subject=100%%20done"],
    ["mailto:a@example.com#fragment", "mailto:a@example.com#fragment"],
    ["mailto:a@example.com?subject=hello world ", "mailto:a@example.com?subject=hello%20world%20"],
  ])
    expect(externalUrl(raw)).toBe(expected);
});
