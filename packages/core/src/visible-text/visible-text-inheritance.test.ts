import { expect, it } from "vitest";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { createVisibleTextTrace } from "./visible-text-diagnostics.js";
import { sanitizeReaderHtml } from "../reader/reader-sanitize.js";
import { htmlToText } from "../mime/mime.js";
import { modelContext } from "../model-view.js";
import type { Message } from "../domain/domain.js";

const template = (
  source: "inline" | "stylesheet",
  outer: string,
  inner: string,
  text = "NewsletterBodyCanary",
) =>
  source === "inline"
    ? `<table><tr><td style="${outer}"><div style="${inner}">${text}</div></td></tr></table>`
    : `<style>.gap{${outer}} .copy{${inner}}</style><table><tr><td class="gap"><div class="copy">${text}</div></td></tr></table>`;
const message = (html: string): Message => ({
  id: "fixture",
  accountId: "fixture-account",
  threadId: "fixture-thread",
  subject: "Fixture",
  from: { name: "Fixture", address: "fixture@example.test" },
  to: [],
  cc: [],
  date: 0,
  snippet: "",
  bodyText: "NewsletterBodyCanary",
  bodyHtml: html,
  labels: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
  attachments: [],
});

for (const source of ["inline", "stylesheet"] as const) {
  it(`${source}: outer td font-size:0 permits an explicit 14px child in reader, model and search`, () => {
    const html = template(source, "font-size:0", "font-size:14px");
    expect(visibleHtmlText(html)).toEqual({ text: "NewsletterBodyCanary", hidden: false });
    const reader = sanitizeReaderHtml(html);
    expect(visibleHtmlText(reader).text).toBe("NewsletterBodyCanary");
    expect(messageModelText("NewsletterBodyCanary", html)).toEqual({
      text: "NewsletterBodyCanary",
      flags: [],
    });
    expect(modelContext([message(html)]).messages[0]?.text).toBe("NewsletterBodyCanary");
    expect(htmlToText(html)).toBe("NewsletterBodyCanary");
  });
  it.each(["1em", "100%", "1px"])(`${source}: %s under a zero-size td remains hidden`, (size) => {
    const html = template(source, "font-size:0", `font-size:${size}`, "PrivateAttackCanary");
    expect(visibleHtmlText(html)).toEqual({ text: "", hidden: true });
    expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("");
    expect(messageModelText("PrivateAttackCanary", html).text).toBe("");
    expect(htmlToText(html)).toBe("");
  });
  it(`${source}: visibility:visible overrides a hidden ancestor only for that child`, () => {
    const html = template(source, "visibility:hidden", "visibility:visible").replace(
      "</td>",
      "<span>PrivateHiddenSiblingCanary</span></td>",
    );
    expect(visibleHtmlText(html)).toEqual({ text: "NewsletterBodyCanary", hidden: true });
    expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("NewsletterBodyCanary");
    expect(messageModelText("NewsletterBodyCanary PrivateHiddenSiblingCanary", html).text).toBe(
      "NewsletterBodyCanary",
    );
    expect(htmlToText(html)).toBe("NewsletterBodyCanary");
  });
  for (const outer of [
    "display:none",
    "opacity:0",
    "clip:rect(0,0,0,0)",
    "clip-path:inset(100%)",
    "overflow:hidden;height:0",
  ]) {
    it(`${source}: ${outer} cannot be undone by a readable child`, () => {
      const html = template(
        source,
        outer,
        "font-size:14px;visibility:visible;display:block;opacity:1;clip:auto;clip-path:none;overflow:visible;height:100px",
        "PrivateAttackCanary",
      );
      expect(visibleHtmlText(html).text).toBe("");
      expect(messageModelText("PrivateAttackCanary", html).text).toBe("");
    });
  }
}

it.each(["14px", "12pt", "1rem"])(
  "an absolute/root-relative %s child resets a zero-sized parent",
  (size) => {
    expect(visibleHtmlText(template("inline", "font-size:0", `font-size:${size}`)).text).toBe(
      "NewsletterBodyCanary",
    );
  },
);

it("relative sizes compose against the computed parent size, including tiny ancestors", () => {
  for (const inner of ["font-size:50%", "font-size:.5em"]) {
    const html = `<div style="font-size:4px"><div style="${inner}"><span style="font-size:.5em">PrivateAttackCanary</span></div></div>`;
    expect(visibleHtmlText(html).text).toBe("");
  }
  expect(visibleHtmlText(template("inline", "font-size:1px", "font-size:14px")).text).toBe(
    "NewsletterBodyCanary",
  );
  expect(visibleHtmlText(template("inline", "font-size:20px", "font-size:.5em")).text).toBe(
    "NewsletterBodyCanary",
  );
});

it("stylesheet hiding for inherited properties yields to an inline override", () => {
  const html =
    '<style>.copy{font-size:0;visibility:hidden}</style><p class="copy" style="font-size:14px;visibility:visible">NewsletterBodyCanary</p>';
  expect(visibleHtmlText(html)).toEqual({ text: "NewsletterBodyCanary", hidden: false });
});

it("hidden and aria-hidden ancestors remain barriers to descendant font and visibility overrides", () => {
  for (const attrs of ["hidden", 'aria-hidden="true"']) {
    const html = `<div ${attrs} style="font-size:0;visibility:hidden"><p style="font-size:14px;visibility:visible">PrivateAttackCanary</p></div>`;
    expect(visibleHtmlText(html).text).toBe("");
  }
});

it("explain attributes font/visibility removal to text leaves and retains overridden descendants", () => {
  const html =
    '<table><tr><td style="font-size:0">PrivateZeroCanary<div style="font-size:14px">NewsletterBodyCanary</div><span style="font-size:1px">PrivateTinyCanary</span><div style="visibility:hidden;font-size:14px">PrivateVisibilityCanary<span style="visibility:visible">VisibleOverrideCanary</span></div></td></tr></table>';
  const trace = createVisibleTextTrace(html);
  const text = visibleHtmlText(html, {
    budgetFallback: "visible",
    diagnostic: trace.diagnostic,
    observer: trace.observer,
  });
  const explained = trace.finish(text);
  expect(text.text).toContain("NewsletterBodyCanary");
  expect(text.text).toContain("VisibleOverrideCanary");
  for (const rule of ["font-size-zero", "font-size-small", "visibility"] as const)
    expect(explained.removedByRule[rule].textNodes).toBe(1);
  expect(explained.retainedTextNodes).toBe(2);
});

it("invalid or inherited font/visibility declarations do not reveal zero-sized text", () => {
  for (const size of ["inherit", "unset", "14", "invalid", "-1px", `${"9".repeat(400)}em`]) {
    expect(visibleHtmlText(template("inline", "font-size:0", `font-size:${size}`)).text).toBe("");
  }
  expect(
    visibleHtmlText(template("inline", "visibility:hidden", "visibility:inherit;font-size:14px"))
      .text,
  ).toBe("");
  expect(
    visibleHtmlText(template("inline", "visibility:hidden", "visibility:unset;font-size:14px"))
      .text,
  ).toBe("");
});

it("rem inherits the computed root size rather than the immediate parent", () => {
  const html =
    '<html><head><style>html{font-size:0}</style></head><body style="font-size:14px"><p style="font-size:1rem">PrivateAttackCanary</p><p style="font-size:1em">NewsletterBodyCanary</p></body></html>';
  expect(visibleHtmlText(html).text).toBe("NewsletterBodyCanary");
});

it.each(["-0px", "+0pt", "1e-2em", "1e-1px"])(
  "valid zero/tiny numeric syntax %s does not disclose text",
  (size) => {
    expect(visibleHtmlText(template("inline", "font-size:14px", `font-size:${size}`)).text).toBe(
      "",
    );
  },
);

it("invalid CSS dimensions cannot restore text under a zero-size container", () => {
  for (const size of ["14 px", "14/**/px", "\\31 4px", "1\\34 px", "100 %"]) {
    for (const source of ["inline", "stylesheet"] as const) {
      expect(visibleHtmlText(template(source, "font-size:0", `font-size:${size}`)).text).toBe("");
    }
  }
  expect(visibleHtmlText(template("inline", "font-size:0", "font-size:14p\\78")).text).toBe(
    "NewsletterBodyCanary",
  );
});

it("invalid inline inheritance declarations cannot override valid stylesheet hiding", () => {
  const html =
    '<style>.copy{font-size:0;visibility:hidden}</style><p class="copy" style="font-size:14 px;visibility:vi/**/sible">PrivateAttackCanary</p>';
  expect(visibleHtmlText(html).text).toBe("");
});

it("important declarations apply on their element, while their inherited values remain overridable", () => {
  const hidden =
    '<style>.copy{font-size:0!important;visibility:hidden!important}</style><p class="copy" style="font-size:14px;visibility:visible">PrivateAttackCanary</p>';
  expect(visibleHtmlText(hidden).text).toBe("");
  const child =
    '<style>.gap{font-size:0!important;visibility:hidden!important}</style><div class="gap"><p style="font-size:14px;visibility:visible">NewsletterBodyCanary</p></div>';
  expect(visibleHtmlText(child).text).toBe("NewsletterBodyCanary");
});
