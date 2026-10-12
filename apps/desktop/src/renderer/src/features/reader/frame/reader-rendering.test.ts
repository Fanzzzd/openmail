import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { sanitizeReaderHtml } from "./reader-html";
import { desktopRoot } from "../../../test-support/paths";
// @vitest-environment jsdom

const fixture = (name: string) =>
  readFileSync(
    resolve(desktopRoot, `../../packages/core/src/fixtures/reader/${name}.html`),
    "utf8",
  );
function render(input: string): HTMLElement {
  const root = document.createElement("section");
  root.innerHTML = sanitizeReaderHtml(input, false);
  document.body.replaceChildren(root);
  return root;
}

it("Outlook's first rule actually styles the message after browser parsing", () => {
  const root = render(fixture("outlook-word"));
  const paragraph = root.querySelector("p.MsoNormal");
  if (!paragraph) throw new Error("Missing Outlook paragraph");
  const style = window.getComputedStyle(paragraph);
  expect(style.fontFamily).toBe("Arial");
  expect(style.fontSize).toBe("16px");
  expect(style.color).toBe("rgb(18, 52, 86)");
  expect(root.textContent).not.toContain("Quarterly report");
  expect(root.querySelector("a")?.getAttribute("href")).toBe("https://reports.example.test/q3");
});

it("Mailchimp hero cells retain their visible background after images are blocked", () => {
  const root = render(fixture("mailchimp-newsletter"));
  const hero = root.querySelector("td.hero");
  if (!hero) throw new Error("Missing newsletter hero");
  expect(window.getComputedStyle(hero).backgroundColor).toBe("rgb(18, 52, 86)");
  expect(window.getComputedStyle(hero).color).toBe("rgb(255, 255, 255)");
  expect(root.textContent).toContain("Your October update");
  expect(root.textContent).not.toContain("October member newsletter");
  expect(root.innerHTML).not.toContain("images.example.test");
});

it("browser sanitation preserves font, table, image map and static details markup", () => {
  const root = render(fixture("presentational"));
  expect(root.querySelector("font")?.getAttribute("face")).toBe("Georgia");
  expect(root.querySelector("td")?.hasAttribute("nowrap")).toBe(true);
  expect(root.querySelector("table")?.getAttribute("rules")).toBe("rows");
  expect(root.querySelector("table")?.getAttribute("frame")).toBe("box");
  expect(root.querySelector("img")?.getAttribute("usemap")).toBe("#navigation");
  expect(root.querySelector("img")?.getAttribute("hspace")).toBe("8");
  expect(root.querySelector("area")?.getAttribute("href")).toBe("https://news.example.test/");
  expect(root.querySelector("main")).not.toBeNull();
  expect(root.querySelector("mark")).not.toBeNull();
  expect(root.textContent).toContain("Delivery is Friday.");
  expect(root.querySelector("details")).toBeNull();
  const body = root.querySelector(".openmail-reader-body");
  if (!body) throw new Error("Missing body appearance wrapper");
  expect(window.getComputedStyle(body).backgroundColor).toBe("rgb(255, 255, 238)");
  expect(window.getComputedStyle(body).color).toBe("rgb(34, 51, 68)");
});

it("a 140-deep reply chain survives the final browser sanitizer", () => {
  const root = render(
    `${"<blockquote><p>Reply</p>".repeat(140)}<p>Original order</p>${"</blockquote>".repeat(140)}`,
  );
  expect(root.textContent).toContain("Original order");
  expect(root.querySelectorAll("blockquote")).toHaveLength(140);
});
