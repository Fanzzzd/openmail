import type { WebPreferences } from "electron";
import { hasAsciiControl } from "../../shared/external-url";

export const APP_SCHEME = "openmail-app";
export const APP_PAGE = `${APP_SCHEME}://app/index.html`;
export const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: cid:; font-src 'self' data:; frame-src 'self' about:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Explicit defaults apply to visible and hidden windows alike. */
export const WINDOW_SECURITY = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: true,
} satisfies WebPreferences;

/** A packaged app ignores ELECTRON_RENDERER_URL. Development accepts only loopback. */
export function developmentPage(packaged: boolean, raw: string | undefined): string | null {
  if (packaged || !raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function isAppPage(raw: string, devPage: string | null): boolean {
  try {
    const url = new URL(raw);
    const page = new URL(devPage ?? APP_PAGE);
    return (
      url.protocol === page.protocol &&
      url.host === page.host &&
      url.pathname === page.pathname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** These are OS-provided file paths, never URLs or percent-decoded paths. */
export function validOpenFile(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= 4096 &&
    !hasAsciiControl(file) &&
    !file.startsWith("//") &&
    !file.startsWith("\\\\") &&
    (file.startsWith("/") || /^[a-z]:[\\/]/i.test(file))
  );
}

/** Mail subjects can label reader windows, without control characters or unbounded titles. */
export function readerWindowTitle(value: string): string {
  return (
    Array.from(value)
      .filter((character) => !/[\p{Cc}]/u.test(character))
      .slice(0, 200)
      .join("")
      .trim() || "OpenMail"
  );
}
