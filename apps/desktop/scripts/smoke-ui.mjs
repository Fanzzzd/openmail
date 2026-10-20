import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Re-query and click in one renderer turn. A completed navigation is never clicked again. */
export function smokeClickExpression(selector, ready) {
  return `(() => {
    const ready = ${JSON.stringify(ready ?? null)};
    if (ready && document.querySelector(ready)) return true;
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || !element.isConnected || element.disabled) return false;
    element.click();
    return ready ? !!document.querySelector(ready) : true;
  })()`;
}

export function isBlockedSmokeImage(source, text) {
  return (
    source === "about:srcdoc" &&
    (/^Loading the image '[^\r\n]*' violates the following Content Security Policy directive: "img-src data: cid:"\. The action has been blocked\.$/.test(
      text,
    ) ||
      /^Refused to load the image '[^\r\n]*' because it violates the following Content Security Policy directive: "img-src data: cid:"\.$/.test(
        text,
      ))
  );
}

/**
 * The preview's environment. Offline unless `--network` asks for provider calls: the copied
 * database keeps real accounts and the keychain still has their tokens, so a default run
 * would sync, refresh tokens and fetch contacts against Gmail, Outlook and IMAP servers.
 *
 * `windows` is "hidden" for harnesses that only drive the renderer over CDP: a development build
 * then creates and paints its windows but never shows them. "background" is for harnesses that
 * need a visible window; they show without focus and must run on a virtual display (see
 * `requireVisibleWindows`).
 */
export function smokeEnvironment(base, directory, network = false, windows = "hidden") {
  const env = { ...base, OPENMAIL_READ_ONLY: "1", OPENMAIL_HOME: directory };
  delete env.OPENMAIL_HIDDEN_WINDOWS;
  delete env.OPENMAIL_BACKGROUND_WINDOWS;
  if (windows === "hidden") env.OPENMAIL_HIDDEN_WINDOWS = "1";
  else env.OPENMAIL_BACKGROUND_WINDOWS = "1";
  if (network) delete env.OPENMAIL_OFFLINE;
  else env.OPENMAIL_OFFLINE = "1";
  return env;
}

/** The variable that acknowledges a harness will put windows on the current screen. */
export const VISIBLE_WINDOWS_OK = "OPENMAIL_VISIBLE_WINDOWS_OK";

/**
 * Stops a harness that shows real windows unless the caller set OPENMAIL_VISIBLE_WINDOWS_OK=1,
 * which says the run is on agent-screen, another virtual display or a CI runner, never on the
 * screen of someone at work. Returns the refusal message, or null when the run may go on.
 */
export function visibleWindowsRefusal(env, harness, reason) {
  if (env[VISIBLE_WINDOWS_OK] === "1") return null;
  return [
    `${harness} shows real windows on the current screen: ${reason}.`,
    "Run it on agent-screen or another virtual display, or on a CI runner, and set",
    `${VISIBLE_WINDOWS_OK}=1 to confirm. See docs/testing.md#windows-in-automated-runs.`,
  ].join("\n");
}

/** Exits with code 2 and the refusal message when `visibleWindowsRefusal` refuses. */
export function requireVisibleWindows(harness, reason) {
  const refusal = visibleWindowsRefusal(process.env, harness, reason);
  if (!refusal) return;
  process.stderr.write(`${refusal}\n`);
  process.exit(2);
}

/**
 * The build outputs a development run loads, relative to apps/desktop: the Electron main bundle
 * and the MCP server of @openmail/cli.
 */
const BUILD_OUTPUTS = ["out/main/index.js", "../../packages/cli/dist/mcp-server.js"];

/**
 * Returns why `desktop` (the apps/desktop directory) has no complete build, or null when it has
 * one. Without the main bundle Electron reports the load error in a native box on the current
 * screen before the app can apply hidden windows, so a hidden harness checks first.
 */
export function missingBuild(desktop, exists = existsSync) {
  const missing = BUILD_OUTPUTS.map((file) => join(desktop, file)).filter((file) => !exists(file));
  if (missing.length === 0) return null;
  return [
    `The build is missing: ${missing.join(", ")}.`,
    "Run `pnpm build` from the repo root first. Without it Electron shows its own error box.",
  ].join("\n");
}

/** Exits with code 2 and the message when `missingBuild` finds outputs missing. */
export function requireBuild() {
  const missing = missingBuild(fileURLToPath(new URL("..", import.meta.url)));
  if (!missing) return;
  process.stderr.write(`${missing}\n`);
  process.exit(2);
}
