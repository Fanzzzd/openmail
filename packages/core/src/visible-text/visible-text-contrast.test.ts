import { expect, it } from "vitest";
import { visibleHtmlText } from "./visible-text.js";
import { textContrast } from "./visible-text-paint.js";
import { preservedComposeHtml, remoteComposeBody } from "../compose/compose-body.js";

it("uses relative luminance and effective opacity for contrast", () => {
  expect(textContrast([0, 0, 0, 1], [255, 255, 255, 1])).toBe(21);
  expect(textContrast([0, 0, 0, 1], [255, 255, 255, 1], 2)).toBe(21);
  expect(textContrast([0, 0, 0, 1], [17, 17, 17, 1])).toBeCloseTo(1.112, 3);
  expect(textContrast([0, 0, 0, 0.6], [255, 255, 255, 1], 0.2)).toBeLessThan(1.5);
});

it("zoom changes geometry without reducing colour contrast", () => {
  expect(visibleHtmlText('<p style="zoom:200%;color:#000;background:#fff">Readable</p>').text).toBe(
    "Readable",
  );
});

it.each(["#000000", "#0d0d0d", "#333333"])(
  "low-contrast %s is excluded from model text, editor and transport",
  (colour) => {
    for (const source of [
      `<div style="background:#111"><span style="color:${colour}">SECRET</span></div>`,
      `<style>.paper{background-color:#111}.ink{color:${colour}}</style><div class="paper"><span class="ink">SECRET</span></div>`,
      `<table bgcolor="#111111"><tr><td><font color="${colour}">SECRET</font></td></tr></table>`,
    ]) {
      const html = `${source}<p>Visible</p>`;
      expect(visibleHtmlText(html).text).toBe("Visible");
      const body = remoteComposeBody(html);
      expect(body.text).toBe("Visible");
      expect(body.html).not.toContain("SECRET");
      expect(body.hiddenTextRemoved).toBe(true);
      const transport = preservedComposeHtml(body.originalHtml ?? "");
      expect(transport).not.toContain("SECRET");
      expect(preservedComposeHtml(transport)).toBe(transport);
      expect(visibleHtmlText(transport).text).toBe(body.text);
    }
  },
);

it.each(["#343434", "#ffffff"])(
  "intentional %s above the contrast threshold stays visible",
  (colour) => {
    const html = `<div style="background-color:#111;color:${colour}"><span>Readable</span></div>`;
    expect(visibleHtmlText(html).text).toBe("Readable");
    const body = remoteComposeBody(html);
    expect(body.text).toBe("Readable");
    expect(body.html).toContain(`color:${colour}`);
    expect(body.hiddenTextRemoved).toBeUndefined();
    const transport = preservedComposeHtml(body.originalHtml ?? "");
    expect(preservedComposeHtml(transport)).toBe(transport);
  },
);

it("evaluates translucent backgrounds and inherited opacity against their effective paint", () => {
  for (const html of [
    '<div style="background:#fff;opacity:0.2"><span style="color:rgba(0,0,0,0.6)">SECRET</span></div>',
    '<div style="background:#fff"><p style="background:rgba(17,17,17,0.9);color:#000">SECRET</p></div>',
  ])
    expect(visibleHtmlText(html).text).toBe("");
});
