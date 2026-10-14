import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import {
  smokeClickExpression,
  isBlockedSmokeImage,
  smokeEnvironment,
} from "../../../../scripts/smoke-ui.mjs";
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
