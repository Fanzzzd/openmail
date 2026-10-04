import { expect, it } from "vitest";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { sanitizeReaderHtml } from "./reader-sanitize.js";

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
it.each(["data-ogsc", "data-ogsb"])(
  "sanitizer-only attribute %s matches no reader element",
  (attribute) => {
    const html = `<style>.paper{background-color:white}.text{color:black}[${attribute}] .text{color:white!important}</style><div ${attribute} class="paper"><p class="text">VISIBLE</p></div>`;
    expect(sanitizeReaderHtml(html)).not.toContain(`<div ${attribute}`);
    expect(visibleHtmlText(html).text).toBe("VISIBLE");
  },
);
it.each(["background:black", "background-image:linear-gradient(black,black)"])(
  "ancestor %s establishes a colour match",
  (background) => {
    expect(
      visibleHtmlText(`<div style="${background}"><p style="color:black">SECRET</p></div>`).text,
    ).toBe("");
  },
);
it("nearest painted ancestor overrides an earlier painted ancestor", () => {
  const html =
    '<div style="background-color:black"><section bgcolor="white"><p style="color:black">VISIBLE</p></section></div>';
  expect(visibleHtmlText(html).text).toBe("VISIBLE");
});

it("opposite hover scenarios remain correlated when both occur in one message", () => {
  const html =
    '<style>.paper{background-color:white}.text{color:black}@media(hover:hover){.paper{background-color:#333}.text{color:white}}@media(hover:none){.paper{background-color:white}.text{color:black}}</style><div class="paper"><p class="text">VISIBLE</p></div>';
  expect(visibleHtmlText(html).text).toBe("VISIBLE");
});
it("scenario expansion is bounded and never forwards fallback text to the model", () => {
  const groups = Array.from(
    { length: 7 },
    (_, i) => `@media(unknown-feature-${i}:1){.x{color:white;background-color:#333}}`,
  ).join("");
  const html = `<style>${groups}</style><p class="x">SECRET</p>`;
  expect(visibleHtmlText(html)).toHaveProperty("flags", ["budget-exceeded"]);
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
});

it("blocked URL backgrounds retain text contrasting with the fallback colour", () => {
  expect(
    visibleHtmlText(
      '<div style="background:white url(https://images.invalid/background.png)"><p style="color:black">VISIBLE</p></div>',
    ).text,
  ).toBe("VISIBLE");
});
