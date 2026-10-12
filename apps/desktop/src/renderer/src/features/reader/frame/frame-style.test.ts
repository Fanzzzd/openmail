// @vitest-environment jsdom
import { expect, it } from "vitest";
import { READER_BASE_CSS } from "@openmail/core/schema";
import { DARK_CSS, fitDocument, fitLayout, fitScale, MIN_FIT_SCALE, PICTURES } from "./frame-style";

it("fits wide mail to the frame and leaves mail that fits alone", () => {
  expect(fitScale(600, 600)).toBe(1);
  expect(fitScale(600.5, 600)).toBe(1);
  expect(fitScale(400, 600)).toBe(1);
  expect(fitScale(800, 400)).toBe(0.5);
  expect(fitScale(2000, 400)).toBe(MIN_FIT_SCALE);
  expect(fitScale(800, 0)).toBe(1);
});

it("scrolls sideways only when the scaled page is still wider than the frame", () => {
  // Fit on: a page that scales to the frame has nothing to the side.
  expect(fitLayout(800, 400, true)).toEqual({ scale: 0.5, wide: true, scrolls: false });
  expect(fitLayout(742, 632, true)).toMatchObject({ wide: true, scrolls: false });
  // Past the smallest scale the rest of the page is real content.
  expect(fitLayout(2000, 400, true)).toEqual({ scale: MIN_FIT_SCALE, wide: true, scrolls: true });
  // At 100% a wide page scrolls by its full width.
  expect(fitLayout(800, 400, false)).toEqual({ scale: 1, wide: true, scrolls: true });
  // A pixel or less of fractional overflow is not worth a scroll.
  expect(fitLayout(400.8, 400, false)).toEqual({ scale: 1, wide: false, scrolls: false });
  expect(fitLayout(401, 400, true)).toEqual({ scale: 1, wide: false, scrolls: false });
  expect(fitLayout(380, 400, true)).toEqual({ scale: 1, wide: false, scrolls: false });
});

/** A frame `frame` px wide whose page lays out `natural` px wide and `height` px tall. */
function frameDocument(natural: number, frame: number, height: number) {
  const doc = document.implementation.createHTMLDocument("mail");
  const root = doc.documentElement;
  // Like Chromium: the root's layout width is its set width times its zoom.
  const zoom = () => Number(root.style.zoom || 1);
  Object.defineProperty(root, "scrollWidth", {
    get: () => (root.style.width ? Number.parseFloat(root.style.width) : natural) * zoom(),
  });
  Object.defineProperty(root, "clientWidth", { value: frame });
  Object.defineProperty(root, "scrollHeight", { get: () => height * zoom() });
  return doc;
}

it("zooms the page to the frame so its layout width is the scaled width", () => {
  const doc = frameDocument(800, 400, 1000);
  const root = doc.documentElement;
  expect(fitDocument(doc, true)).toEqual({ height: 500, wide: true });
  expect(root.style.width).toBe("800px");
  expect(root.style.zoom).toBe("0.5");
  expect(root.style.getPropertyPriority("zoom")).toBe("important");
  expect(root.style.transform).toBe("");
  // Nothing past the scaled page to scroll to.
  expect(root.scrollWidth).toBe(400);
  expect(root.style.overflowX).toBe("hidden");
  expect(root.style.getPropertyPriority("overflow-x")).toBe("important");
  // Measuring again starts from the natural width, not the one it set.
  expect(fitDocument(doc, true)).toEqual({ height: 500, wide: true });
  // At 100% the page keeps its width and scrolls sideways.
  expect(fitDocument(doc, false)).toEqual({ height: 1000, wide: true });
  expect(root.style.zoom).toBe("");
  expect(root.style.width).toBe("");
  expect(root.style.overflowX).toBe("auto");
});

it("returns a page scrolled at 100% to its left edge when it fits again", () => {
  const doc = frameDocument(800, 400, 1000);
  const root = doc.documentElement;
  fitDocument(doc, false);
  root.scrollLeft = 300;
  fitDocument(doc, true);
  expect(root.scrollLeft).toBe(0);
});

it("lets a page wider than the smallest scale scroll by what is left over", () => {
  const doc = frameDocument(2000, 400, 1000);
  const root = doc.documentElement;
  expect(fitDocument(doc, true)).toEqual({ height: 400, wide: true });
  expect(root.style.zoom).toBe(String(MIN_FIT_SCALE));
  expect(root.scrollWidth).toBe(800);
  expect(root.style.overflowX).toBe("auto");
});

it("reports mail that fits as not wide and hides sub-pixel overflow", () => {
  const doc = frameDocument(400.6, 400, 700);
  expect(fitDocument(doc, true)).toEqual({ height: 700, wide: false });
  expect(doc.documentElement.style.zoom).toBe("");
  expect(doc.documentElement.style.overflowX).toBe("hidden");
});

/** How many times dark mode inverts an element: the page once, plus each picture rule that applies. */
function inversions(element: Element) {
  let count = 1;
  for (let node: Element | null = element; node; node = node.parentElement)
    if (node.matches(PICTURES) && !node.matches(`:is(${PICTURES}) :is(${PICTURES})`)) count++;
  return count;
}

it("inverts each element at most once more than the page in dark mode", () => {
  expect(DARK_CSS).toContain(`:is(${PICTURES}) :is(${PICTURES}) { filter: none; }`);
  document.body.innerHTML = `
    <div id="none" style="background-image:none">SECRET</div>
    <div id="color" style="background: #fff">Plain</div>
    <div id="photo" style="background: URL(cid:hero)"><p id="caption">Hi</p><img id="nested"></div>
    <div id="gradient" style="background-image: linear-gradient(red, blue)">Sale</div>
    <table><tr><td id="legacy" background="cid:tile">Cell</td></tr></table>
    <picture id="picture"><img id="inner"></picture>
    <img id="logo">`;
  const count = (id: string) => inversions(document.getElementById(id)!);
  // Text without a picture behind it turns light with the page.
  expect(count("none")).toBe(1);
  expect(count("color")).toBe(1);
  expect(count("gradient")).toBe(1);
  // Pictures and everything drawn on them keep the sender's colors.
  for (const id of ["photo", "caption", "nested", "legacy", "picture", "inner", "logo"])
    expect(count(id), id).toBe(2);
});

it("gradient-only backgrounds and their text receive only the page inversion", () => {
  document.body.innerHTML =
    '<div style="background-image:linear-gradient(#000,#000)"><span id="ink" style="color:#fff">Visible</span></div>';
  expect(inversions(document.getElementById("ink")!)).toBe(1);
});

it("vector text is inverted with the page while embedded SVG images keep their colours", () => {
  document.body.innerHTML =
    '<svg><text id="vector">Visible</text><image id="raster"></image></svg>';
  expect(inversions(document.getElementById("vector")!)).toBe(1);
  expect(inversions(document.getElementById("raster")!)).toBe(2);
});

it("breaks long words anywhere in text but keeps table cells at word width", () => {
  document.head.innerHTML = `<style>${READER_BASE_CSS}</style>`;
  document.body.innerHTML = "<p>text</p><table><tr><td>Status</td><th>Job</th></tr></table>";
  const wrap = (selector: string) =>
    getComputedStyle(document.querySelector(selector)!).getPropertyValue("overflow-wrap");
  expect(wrap("p")).toBe("anywhere");
  // "anywhere" would shrink a cell's minimum width to one letter.
  expect(wrap("td")).toBe("break-word");
  expect(wrap("th")).toBe("break-word");
});
