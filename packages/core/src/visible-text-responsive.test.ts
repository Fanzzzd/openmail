import { expect, it } from "vitest";
import { htmlToText } from "./mime.js";
import { sanitizeReaderHtml, sanitizeReaderCss } from "./reader-sanitize.js";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { createVisibleTextTrace } from "./visible-text-diagnostics.js";

const responsive = (variant: "desktop" | "mobile", hiding: "inline" | "stylesheet") => {
  const query = variant === "desktop" ? "min-width:0px" : "max-width:8000px";
  const otherQuery = variant === "desktop" ? "min-width:8001px" : "min-width:8001px";
  const base = hiding === "stylesheet" ? ".desktop,.mobile{display:none}" : "";
  const attrs = hiding === "inline" ? ' style="display:none"' : "";
  return `<style>${base}
    @media only screen and (${query}) {table[class~="${variant}"]:not(.excluded){display:block !important}}
    @media screen and (${otherQuery}) {.${variant === "desktop" ? "mobile" : "desktop"}{display:block !important}}
    </style><table class="desktop"${attrs}><tr><td>DesktopBodyCanary</td></tr></table>
    <table class="mobile"${attrs}><tr><td>MobileBodyCanary</td></tr></table>`;
};

for (const variant of ["desktop", "mobile"] as const) {
  for (const hiding of ["inline", "stylesheet"] as const) {
    it(`${hiding}: reveals the responsive ${variant} version at both reference reader widths`, () => {
      const html = responsive(variant, hiding);
      const expected = variant === "desktop" ? "DesktopBodyCanary" : "MobileBodyCanary";
      const result = visibleHtmlText(html);
      expect(result).toEqual({ text: expected, hidden: true });
      expect(visibleHtmlText(sanitizeReaderHtml(html))).toEqual(result);
      expect(htmlToText(html)).toBe(expected);
      expect(messageModelText("DesktopBodyCanary MobileBodyCanary", html).text).toBe(expected);
      const trace = createVisibleTextTrace(html);
      const explained = trace.finish(
        visibleHtmlText(html, {
          budgetFallback: "visible",
          diagnostic: trace.diagnostic,
          observer: trace.observer,
        }),
      );
      expect(explained.removedByRule["display-none"].textNodes).toBe(1);
      expect(explained.retainedTextNodes).toBeGreaterThan(0);
    });
  }
}

it.each([
  "print",
  "print and (min-width:1px)",
  "screen and (max-width:0px)",
  "screen and (min-width:801px)",
  "screen and (max-width:799px)",
  "screen and (min-width:900px) and (max-width:700px)",
  "screen and (unknown-feature:1)",
  "screen and (width:garbage)",
])("%s never reveals hidden attacker text", (query) => {
  const html = `<style>.attack{display:none}@media ${query}{.attack{display:block!important}}</style><p class="attack">PrivateAttackCanary</p><p>VisibleCanary</p>`;
  expect(visibleHtmlText(html).text).toBe("VisibleCanary");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("VisibleCanary");
  expect(messageModelText("PrivateAttackCanary VisibleCanary", html).text).toBe("VisibleCanary");
});

it("an unmatched print rule cannot hide screen content", () => {
  expect(
    visibleHtmlText("<style>@media print{p{display:none}}</style><p>VisibleCanary</p>").text,
  ).toBe("VisibleCanary");
});

it.each([
  ".attack{display:none!important}@media screen{.attack{display:block}}",
  "#secret{display:none}@media screen{.attack{display:block}}",
  ".attack{display:none!important}@media screen{:where(#secret){display:block!important}}",
  ".attack{display:none!important}@media screen{:is(p,.attack){display:block}}",
  ".attack{display:none}@media screen{.attack{display:garbage!important}}",
  ".attack{display:none}@media screen and (max-width:0){.attack{display:block!important}}",
])("cascade keeps attacker text hidden: %s", (css) => {
  const html = `<style>${css}</style><p id="secret" class="attack">PrivateAttackCanary</p><p>VisibleCanary</p>`;
  expect(visibleHtmlText(html).text).toBe("VisibleCanary");
});

it("inline important hiding wins over an important stylesheet reveal", () => {
  const html =
    '<style>@media screen{#secret{display:block!important}}</style><p id="secret" style="display:none!important">PrivateAttackCanary</p>';
  expect(visibleHtmlText(html).text).toBe("");
});

it("same-priority later rules reveal, while greater specificity wins regardless of order", () => {
  for (const css of [
    ".copy{display:none}.copy{display:block}",
    "@media screen{#copy{display:block}}.copy{display:none}",
    ".copy{display:none}@media screen{:is(#copy,.missing){display:block}}",
    '.copy{display:none}@media screen{p[class="copy"]:not(.excluded){display:block}}',
  ]) {
    expect(
      visibleHtmlText(`<style>${css}</style><p id="copy" class="copy">VisibleCanary</p>`).text,
    ).toBe("VisibleCanary");
  }
});

it("a child reveal cannot restore a hidden, transparent or clipped ancestor", () => {
  for (const attrs of [
    "hidden",
    'style="display:none"',
    'style="opacity:0"',
    'style="clip-path:inset(100%)"',
  ]) {
    const html = `<style>@media screen{.copy{display:block!important}}</style><div ${attrs}><p class="copy" style="display:none">PrivateAttackCanary</p></div>`;
    expect(visibleHtmlText(html).text).toBe("");
  }
});

it.each([
  ["(width:800px)", false],
  ["(width:720px)", false],
  ["(width:1080px)", false],
  ["(720px <= width <= 1080px)", false],
  ["(max-width:720px),(min-width:1080px)", false],
  ["screen and (min-width:45em) and (max-width:67.5em)", false],
  ["(719px < width < 721px)", false],
  ["(min-width:800px) and (max-width:800px)", false],
  ["(width >= 800px)", false],
  ["(600px < width < 1000px)", false],
  ["screen and (min-width:50em)", false],
  ["screen and (max-width:49.99rem)", false],
  ["print, screen and (min-width:800px)", false],
  ["not print", true],
  ["(min-width:0px) and (max-width:8000px)", true],
  ["(0px <= width <= 8000px)", true],
  ["(min-width:320px) and (max-width:1920px)", false],
  ["(320px <= width <= 1920px)", false],
  ["screen and (min-width:20em)", false],
  ["(max-width:800px),(min-width:800px)", true],
  ["not screen", false],
  ["not (max-width:0px)", false],
  ["not (unknown-feature:1)", false],
  ["not screen and (unknown-feature:1)", false],
  ["screen and ((width:800px) or (width:0px))", false],
  ["screen and (max-width:0px), print", false],
  ["screen and (width < 800px)", false],
  ["screen and (min-width:0px) garbage", false],
])("media condition %s matches both reference reader widths: %s", (query, matches) => {
  const html = `<style>.copy{display:none}@media ${query}{.copy{display:block!important}}</style><p class="copy">VisibleCanary</p>`;
  expect(visibleHtmlText(html).text).toBe(matches ? "VisibleCanary" : "");
});

it("nested media and style media attributes require every condition to match", () => {
  for (const [outer, inner, visible] of [
    ["screen", "(min-width:0px)", true],
    ["print", "screen", false],
    ["screen", "(max-width:0px)", false],
  ] as const) {
    const html = `<style>.copy{display:none}</style><style media="${outer}">@media ${inner}{.copy{display:block!important}}</style><p class="copy">VisibleCanary</p>`;
    expect(visibleHtmlText(html).text).toBe(visible ? "VisibleCanary" : "");
    expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe(visible ? "VisibleCanary" : "");
  }
});

it("selector lists keep function commas and independently match their specificity", () => {
  const html =
    '<style>.copy{display:none}.missing,:is(.copy,.other){display:block}</style><p class="copy">VisibleCanary</p>';
  expect(visibleHtmlText(html).text).toBe("VisibleCanary");
});

it("important display declarations keep their priority within one style attribute", () => {
  const html =
    '<p style="display:none!important;display:block">PrivateAttackCanary</p><p style="display:none;display:block!important">VisibleCanary</p>';
  expect(visibleHtmlText(html).text).toBe("VisibleCanary");
});

it("Outlook responsive newsletter keeps desktop copy and excludes the narrow-only mobile copy", () => {
  const html =
    '<style>.mobile{display:none}@media screen and (max-width:600px){.desktop{display:none!important}.mobile{display:block!important}}@media screen and (min-width:601px){.desktop{font-size:14px;color:#222;line-height:1.4}}</style><table class="desktop"><tr><td>DesktopNewsletterCanary</td></tr></table><div class="mobile">PrivateMobileCanary</div>';
  expect(visibleHtmlText(html)).toEqual({ text: "DesktopNewsletterCanary", hidden: true });
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("DesktopNewsletterCanary");
  expect(htmlToText(html)).toBe("DesktopNewsletterCanary");
  expect(messageModelText("DesktopNewsletterCanary PrivateMobileCanary", html).text).toBe(
    "DesktopNewsletterCanary",
  );
});

it("partial width font overrides cannot reset zero-sized text outside the safety range", () => {
  const html =
    '<style>.gap{font-size:0}@media(min-width:900px){.gap{font-size:14px}}.copy{font-size:1em}@media(max-width:900px){.copy{font-size:14px}}</style><div class="gap"><p class="copy">VisibleAtBothWidths</p></div>';
  expect(visibleHtmlText(html).text).toBe("");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("");
});
it("identical text in opposite responsive branches is excluded by node identity", () => {
  const html =
    '<style>.narrow,.wide{display:none}@media(max-width:800px){.narrow{display:block!important}}@media(min-width:801px){.wide{display:block!important}}</style><p class="narrow">PrivateIdenticalCanary</p><p class="wide">PrivateIdenticalCanary</p>';
  expect(visibleHtmlText(html).text).toBe("");
  expect(messageModelText("PrivateIdenticalCanary", html).text).toBe("");
});
it("known per-width declarations use the cascade before deciding subtree visibility", () => {
  const html =
    '<style>.copy{opacity:0;overflow:hidden;height:0}@media(min-width:0px){.copy{opacity:1;overflow:visible;height:100px}}</style><p class="copy">VisibleAtBothWidths</p>';
  expect(visibleHtmlText(html).text).toBe("VisibleAtBothWidths");
});
it.each([
  "(prefers-color-scheme:light)",
  "(hover:hover)",
  "(pointer:fine)",
  "(orientation:landscape)",
  "(-webkit-min-device-pixel-ratio:0)",
])("unknown environmental condition %s never reveals text", (condition) => {
  const html = `<style>.copy{display:none}@media${condition}{.copy{display:block!important}}</style><p class="copy">PrivateEnvironmentCanary</p>`;
  expect(visibleHtmlText(html).text).toBe("");
});

const effectsHidden = (html: string) => {
  expect(visibleHtmlText(html).text).not.toContain("SECRET");
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).not.toContain("SECRET");
};
it.each(["(min-width:320px)", "(max-width:1920px)", "(min-width:20em)"])(
  "partial reveal condition %s cannot restore text",
  (query) => {
    effectsHidden(
      `<style>.x{display:none}@media${query}{.x{display:block!important}}</style><p class="x">SECRET</p>`,
    );
  },
);

it("complementary max-600/min-601 reveals cover the safety range", () => {
  expect(
    visibleHtmlText(
      '<style>.x{display:none}@media(max-width:600px){.x{display:block!important}}@media(min-width:601px){.x{display:block!important}}</style><p class="x">VISIBLE</p>',
    ).text,
  ).toBe("VISIBLE");
});

it("partial colour changes preserve inherited hiding alternatives through descendants", () => {
  effectsHidden(
    '<style>.x{color:transparent}@media(min-width:320px){.x{color:black}}</style><div class="x"><span>SECRET</span></div>',
  );
  effectsHidden(
    '<style>.x{background-color:black;color:black}@media(min-width:320px){.x{background-color:white}}</style><div class="x"><span>SECRET</span></div>',
  );
});

it("an uncertain ordinary colour alone does not discard readable descendants", () => {
  expect(
    visibleHtmlText(
      '<style>@media(hover:hover){.x{color:red}}</style><div class="x"><span>VISIBLE</span></div>',
    ).text,
  ).toBe("VISIBLE");
});

const checkHidden = (html: string) => {
  expect(visibleHtmlText(html).text).not.toContain("SECRET");
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).not.toContain("SECRET");
};
it.each([
  "@supports (display:grid){.x{display:none}}",
  "@layer a{.x{display:none}}",
  "@media (hover:hover),(hover:none){.x{display:none}}",
  "@media (orientation:portrait),(orientation:landscape){.x{display:none}}",
  "@media screen and (-webkit-min-device-pixel-ratio:0){.x{display:none}}",
  "@media (prefers-color-scheme:light),(prefers-color-scheme:dark){.x{opacity:0}}",
  "@supports (display:grid){.x{visibility:hidden}}",
  "@supports (display:grid){.x{font-size:0}}",
  "@container (min-width:1px){.x{display:none}}",
  "@media not all and (width:800px){.x{display:none}}",
  "@media (max-width:799.9px),(min-width:800.1px){.x{display:none}}",
  ".x{display:none}@media (width:800px){.x{display:block!important}}",
])("conservative hiding: %s", (css) =>
  checkHidden(
    `<style>${css}</style><div style="container-type:inline-size"><p class="x">SECRET</p></div>`,
  ),
);

it("responsive reveals at both reference widths retain desktop or mobile text", () => {
  for (const variant of ["desktop", "mobile"]) {
    const html = `<style>.desktop,.mobile{display:none}@media screen and (min-width:0px) and (max-width:8000px){.${variant}{display:block!important}}</style><p class="desktop">DESKTOP</p><p class="mobile">MOBILE</p>`;
    expect(visibleHtmlText(html).text).toBe(variant.toUpperCase());
  }
});

it("complementary media queries on one element can establish a reveal at both reference widths", () => {
  const html =
    '<style>.x{display:none}@media(max-width:800px){.x{display:block!important}}@media(min-width:800px){.x{display:block!important}}</style><p class="x">VISIBLE</p>';
  expect(visibleHtmlText(html).text).toBe("VISIBLE");
});

it.each([
  ".x{display:none}@supports(display:grid){.x{display:block!important}}",
  ".x{display:none}@layer a{.x{display:block!important}}",
  ".x{display:none}@container(min-width:1px){.x{display:block!important}}",
  ".x{font-size:0}@media(max-width:800px){.x{font-size:1em!important}}",
  ".x{color:transparent}@media(max-width:800px){.x{color:black!important}}",
  ".x{display:none}@media(max-width:800px){.x{display:block!important}}.x{display:none!important}@media(min-width:800px){.x{display:block!important}}",
])("uncertain or interrupted reveal stays hidden: %s", (css) =>
  checkHidden(`<style>${css}</style><p class="x">SECRET</p>`),
);

const notification = (condition: string) =>
  `<style>body{background-color:#140606}.main-container{background-color:#fff}.dark-font{color:#000!important}@media ${condition}{body{background-color:#262626}.dark-main-container{background-color:#333!important}.dark-font{color:#fff!important}}[data-ogsc] .dark-font{color:#fff!important}[data-ogsc] .dark-main-container{background-color:#333!important}[data-ogsb] .dark-font{color:#fff!important}</style><table><tr><td class="main-container dark-main-container" bgcolor="#fff"><table><tr><td class="background dark-font" style="color:#000"><span>NotificationCanary</span><p>ReceiptCanary</p></td></tr></table></td></tr></table>`;

const readable = (html: string) => {
  expect(visibleHtmlText(html).text).toBe("NotificationCanary\nReceiptCanary");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("NotificationCanary\nReceiptCanary");
  expect(messageModelText("NotificationCanary ReceiptCanary", html).text).toBe(
    "NotificationCanary\nReceiptCanary",
  );
};

it("light and dark notification colours stay paired with their painted ancestors", () =>
  readable(notification("(prefers-color-scheme:dark)")));

it.each([
  "(hover:hover)",
  "(pointer:fine)",
  "(orientation:landscape)",
  "(-webkit-min-device-pixel-ratio:1)",
])("condition %s cannot mix foreground and background from different scenarios", (condition) =>
  readable(notification(condition)),
);

it("a real same-colour match in one consistent scenario still hides text", () => {
  const html =
    '<style>.paper{background-color:white}.text{color:black}@media(prefers-color-scheme:dark){.paper{background-color:#333}.text{color:#333}}</style><div class="paper"><p class="text">SECRET</p></div>';
  expect(visibleHtmlText(html).text).toBe("");
  expect(messageModelText("SECRET", html).text).toBe("");
});

it("opposite hover scenarios remain correlated when both occur in one message", () => {
  const html =
    '<style>.paper{background-color:white}.text{color:black}@media(hover:hover){.paper{background-color:#333}.text{color:white}}@media(hover:none){.paper{background-color:white}.text{color:black}}</style><div class="paper"><p class="text">VISIBLE</p></div>';
  expect(visibleHtmlText(html).text).toBe("VISIBLE");
});

it("width range comparison tokens survive CSS sanitation and repeat sanitation", () => {
  const html =
    '<style>@media(0px <= width <= 8000px){.x{display:block}}</style><p class="x">VISIBLE</p>';
  const clean = sanitizeReaderHtml(html);
  expect(clean).toContain("<=");
  expect(sanitizeReaderHtml(clean)).toBe(clean);
  expect(sanitizeReaderCss('p::before{content:"</style><script>"}', false)).not.toContain(
    "</style",
  );
});
