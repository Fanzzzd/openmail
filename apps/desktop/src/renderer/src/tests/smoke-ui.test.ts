import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import {
  smokeClickExpression,
  isBlockedSmokeImage,
  missingBuild,
  smokeEnvironment,
  visibleWindowsRefusal,
} from "../../../../scripts/smoke-ui.mjs";
import { desktopRoot } from "../test-support/paths";
import { testDom } from "../test-support/test-dom";

it("smoke re-queries after a replaced list row and stops clicking once the reader appears", () => {
  const dom = testDom();
  try {
    const document = dom.window.document;
    dom.element.innerHTML = '<button data-id="one" role="option">First row</button>';
    const expression = smokeClickExpression('[data-id][role="option"]', "article[data-message-id]");
    const row = document.querySelector("button");
    if (!row) throw new Error("Missing row");
    row.addEventListener("click", () => {
      // First-sync rerender replaces the clicked element without opening the reader.
      dom.element.innerHTML = '<button data-id="one" role="option">Replacement row</button>';
    });
    expect(runInNewContext(expression, { document })).toBe(false);
    let clicks = 0;
    document.querySelector("button")?.addEventListener("click", () => {
      clicks++;
      const article = document.createElement("article");
      article.setAttribute("data-message-id", "m1");
      dom.element.append(article);
    });
    expect(runInNewContext(expression, { document })).toBe(true);
    expect(runInNewContext(expression, { document })).toBe(true);
    expect(clicks).toBe(1);
  } finally {
    dom.dispose();
  }
});

it("smoke safely waits for missing or disabled selectors", () => {
  const dom = testDom();
  try {
    const document = dom.window.document;
    const expression = smokeClickExpression("button", "article");
    expect(runInNewContext(expression, { document })).toBe(false);
    dom.element.innerHTML = "<button disabled>Unavailable</button>";
    expect(runInNewContext(expression, { document })).toBe(false);
  } finally {
    dom.dispose();
  }
});

it("smoke ignores only srcdoc remote-image CSP blocks in both Chromium message forms", () => {
  const modern = `Loading the image 'https://example.com/image.png' violates the following Content Security Policy directive: "img-src data: cid:". The action has been blocked.`;
  const legacy = `Refused to load the image 'https://example.com/image.png' because it violates the following Content Security Policy directive: "img-src data: cid:".`;
  for (const text of [modern, legacy]) {
    expect(isBlockedSmokeImage("about:srcdoc", text)).toBe(true);
    expect(isBlockedSmokeImage("openmail-app://app/index.html", text)).toBe(false);
    expect(isBlockedSmokeImage(undefined, text)).toBe(false);
  }
  for (const text of [
    modern.replace("the image", "the script"),
    modern.replace("img-src", "script-src"),
    modern.replace("Content Security Policy", "network"),
    "Image failed to load",
    "Uncaught Error: CSP violation",
  ])
    expect(isBlockedSmokeImage("about:srcdoc", text)).toBe(false);
});

it("smoke runs offline unless --network opts in to provider calls", () => {
  const base = { PATH: "/usr/bin", OPENMAIL_OFFLINE: "0" };
  const offline = smokeEnvironment(base, "/tmp/smoke");
  expect(offline).toMatchObject({
    PATH: "/usr/bin",
    OPENMAIL_OFFLINE: "1",
    OPENMAIL_READ_ONLY: "1",
    OPENMAIL_HOME: "/tmp/smoke",
  });
  const online = smokeEnvironment(base, "/tmp/smoke", true);
  expect(online.OPENMAIL_OFFLINE).toBeUndefined();
  expect(online.OPENMAIL_READ_ONLY).toBe("1");
});

it("smoke windows are hidden by default and background only when a harness asks", () => {
  const base = { OPENMAIL_BACKGROUND_WINDOWS: "1", OPENMAIL_HIDDEN_WINDOWS: "0" };
  const hidden = smokeEnvironment(base, "/tmp/smoke");
  expect(hidden.OPENMAIL_HIDDEN_WINDOWS).toBe("1");
  expect(hidden.OPENMAIL_BACKGROUND_WINDOWS).toBeUndefined();
  const background = smokeEnvironment(base, "/tmp/smoke", false, "background");
  expect(background.OPENMAIL_BACKGROUND_WINDOWS).toBe("1");
  expect(background.OPENMAIL_HIDDEN_WINDOWS).toBeUndefined();
});

it("harnesses that show windows refuse to run without OPENMAIL_VISIBLE_WINDOWS_OK=1", () => {
  const refusal = visibleWindowsRefusal({}, "The check", "it resizes a window");
  expect(refusal).toContain("The check shows real windows on the current screen");
  expect(refusal).toContain("OPENMAIL_VISIBLE_WINDOWS_OK=1");
  expect(visibleWindowsRefusal({ OPENMAIL_VISIBLE_WINDOWS_OK: "0" }, "x", "y")).not.toBeNull();
  expect(visibleWindowsRefusal({ OPENMAIL_VISIBLE_WINDOWS_OK: "1" }, "x", "y")).toBeNull();
});

it("a hidden harness stops before Electron when the build is missing", () => {
  const main = "/repo/apps/desktop/out/main/index.js";
  const mcp = "/repo/packages/cli/dist/mcp-server.js";
  const desktop = "/repo/apps/desktop";
  expect(missingBuild(desktop, (file) => file === main || file === mcp)).toBeNull();
  const noMain = missingBuild(desktop, (file) => file !== main);
  expect(noMain).toContain(`The build is missing: ${main}.`);
  expect(noMain).toContain("pnpm build");
  expect(missingBuild(desktop, () => false)).toContain(`${main}, ${mcp}`);
});

/** Every harness that launches the app with a window, and how it keeps the window off the user's screen. */
it("every Electron harness either hides its windows or requires a virtual display", () => {
  const repo = path.join(desktopRoot, "../..");
  const scripts = [path.join(desktopRoot, "scripts"), path.join(repo, "scripts")].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => path.join(dir, name)),
  );
  const launches = /remote-debugging-port|electron-vite", "preview"|Contents\/MacOS\/OpenMail/;
  const modes: Record<string, string> = {};
  for (const file of scripts) {
    const text = readFileSync(file, "utf8");
    if (!launches.test(text)) continue;
    modes[path.relative(repo, file)] = text.includes("requireVisibleWindows(")
      ? "visible on a virtual display"
      : /smokeEnvironment\([^)]*"hidden"\)/.test(text)
        ? // A hidden harness checks the build first: Electron's own load-error box ignores the mode.
          text.includes("requireBuild()")
          ? "hidden"
          : "hidden without a build check"
        : "unguarded";
  }
  expect(modes).toEqual({
    "apps/desktop/scripts/smoke.mjs": "hidden",
    "apps/desktop/scripts/titlebar-resize.mjs": "visible on a virtual display",
    "scripts/smoke-dist.mjs": "visible on a virtual display",
  });
});
