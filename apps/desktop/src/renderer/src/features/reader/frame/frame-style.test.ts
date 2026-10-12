// @vitest-environment jsdom
import { expect, it } from "vitest";
import { READER_BASE_CSS } from "@openmail/core/schema";
import {
  DARK_CSS,
  fitLayout,
  frameScrollTop,
  keepLeftEdge,
  keepTopEdge,
  measureFrame,
  MIN_FIT_SCALE,
  PICTURES,
  pinFrameLayout,
} from "./frame-style";

it("fits wide mail to the frame and scrolls only when the scaled page is still wider", () => {
  // Fit on: a page that scales to the frame has nothing to the side.
  expect(fitLayout(800, 400, true)).toEqual({ scale: 0.5, wide: true, scrolls: false });
  expect(fitLayout(742, 632, true)).toMatchObject({ wide: true, scrolls: false });
  // Past the smallest scale the rest of the page is real content.
  expect(fitLayout(2000, 400, true)).toEqual({ scale: MIN_FIT_SCALE, wide: true, scrolls: true });
  // Just past the smallest scale: 400.4px in a 400px frame is within the pixel allowance.
  expect(fitLayout(1001, 400, true)).toEqual({ scale: MIN_FIT_SCALE, wide: true, scrolls: false });
  // At 100% a wide page scrolls by its full width.
  expect(fitLayout(800, 400, false)).toEqual({ scale: 1, wide: true, scrolls: true });
  // A pixel or less of fractional overflow is neither scaled nor scrolled.
  expect(fitLayout(600.5, 600, true)).toEqual({ scale: 1, wide: false, scrolls: false });
  expect(fitLayout(400.8, 400, false)).toEqual({ scale: 1, wide: false, scrolls: false });
  expect(fitLayout(401, 400, true)).toEqual({ scale: 1, wide: false, scrolls: false });
  expect(fitLayout(380, 400, true)).toEqual({ scale: 1, wide: false, scrolls: false });
  // A frame not laid out yet.
  expect(fitLayout(800, 0, true)).toEqual({ scale: 1, wide: false, scrolls: false });
});

interface Page {
  /** Laid-out width and height in frame pixels, before fitting. */
  natural: number;
  height: number;
  frame: number;
  /** The mail's own html { zoom }. */
  own?: number;
  /** The frame's height now. */
  view?: number;
  /** A classic scrollbar's height; 0 for overlay scrollbars. */
  bar?: number;
}

/** A frame and its document, with geometry that follows Chromium's for a zoomed root. */
function frameDocument({ natural, height, frame, own = 1, view = 300, bar = 0 }: Page) {
  const iframe = document.createElement("iframe");
  const doc = document.implementation.createHTMLDocument("mail");
  const root = doc.documentElement;
  const zoom = () => Number(root.style.zoom || own);
  const viewport = () => (iframe.style.height === "0px" ? 0 : view);
  let left = 0;
  Object.defineProperties(root, {
    // Like Chromium: the layout width is the set width times the zoom.
    scrollWidth: {
      get: () => (root.style.width ? Number.parseFloat(root.style.width) * zoom() : natural),
    },
    // Like Chromium: never less than the frame.
    scrollHeight: { get: () => Math.max((height * zoom()) / own, viewport()) },
    clientWidth: { value: frame },
    clientHeight: { get: () => viewport() - (root.style.overflowX === "auto" ? bar : 0) },
    scrollLeft: { get: () => left, set: (value: number) => (left = value) },
  });
  Object.defineProperties(doc, {
    scrollingElement: { value: root },
    defaultView: {
      value: { innerHeight: view, getComputedStyle: () => ({ zoom: String(own) }) },
    },
  });
  return { doc, measure: (fit: boolean) => measureFrame(iframe, doc, fit), iframe };
}

it("zooms the page to the frame so its layout width is the scaled width", () => {
  const { doc, measure } = frameDocument({ natural: 800, height: 1000, frame: 400 });
  const root = doc.documentElement;
  expect(measure(true)).toEqual({ height: 500, wide: true });
  expect(root.style.width).toBe("800px");
  expect(root.style.zoom).toBe("0.5");
  expect(root.style.getPropertyPriority("zoom")).toBe("important");
  expect(root.style.transform).toBe("");
  // Nothing past the scaled page to scroll to.
  expect(root.scrollWidth).toBe(400);
  expect(root.style.overflowX).toBe("hidden");
  expect(root.style.getPropertyPriority("overflow-x")).toBe("important");
  // Measuring again starts from the natural width, not the one it set.
  expect(measure(true)).toEqual({ height: 500, wide: true });
  // At 100% the page keeps its width and scrolls sideways.
  expect(measure(false)).toEqual({ height: 1000, wide: true });
  expect(root.style.zoom).toBe("");
  expect(root.style.width).toBe("");
  expect(root.style.overflowX).toBe("auto");
});

it("multiplies the mail's own html zoom by the fit scale", () => {
  const { doc, measure } = frameDocument({ natural: 800, height: 1000, frame: 400, own: 2 });
  const root = doc.documentElement;
  expect(measure(true)).toEqual({ height: 500, wide: true });
  expect(root.style.width).toBe("400px");
  expect(root.style.zoom).toBe("1");
  expect(root.scrollWidth).toBe(400);
});

it("reads the page with the frame collapsed, so a frame taller than the page shrinks", () => {
  // At the frame's 700 px scrollHeight would report 700; the page is 120 px.
  const short = frameDocument({ natural: 300, height: 120, frame: 400, view: 700 });
  expect(short.measure(true)).toEqual({ height: 120, wide: false });
  expect(short.iframe.style.height).toBe("");
  const scaled = frameDocument({ natural: 800, height: 240, frame: 400, view: 700 });
  expect(scaled.measure(true)).toEqual({ height: 120, wide: true });
});

/** Mail styles that size the page to the frame, plus some padding: the page outgrows the frame. */
const FRAME_SIZED = [
  "html, body { height: 100% } body { padding: 20px }",
  "body { min-height: 100vh; padding-bottom: 10px }",
  "html { min-height: 100vh !important } body { height: 100vh !important; margin: 8px }",
];

it.each(FRAME_SIZED)("sizes the page to its content, not the frame: %s", (css) => {
  // jsdom computes styles only for a document in a window: this test's own.
  document.head.innerHTML = `<style>${css}</style>`;
  for (const element of [document.documentElement, document.body]) element.removeAttribute("style");
  pinFrameLayout(document);
  for (const element of [document.documentElement, document.body]) {
    const style = getComputedStyle(element);
    expect(style.height).toBe("auto");
    expect(Number.parseFloat(style.minHeight)).toBe(0);
    expect(element.style.getPropertyPriority("height")).toBe("important");
  }
  expect(document.documentElement.style.overflowY).toBe("hidden");
  expect(document.body.style.overflow).toBe("visible");
  document.head.innerHTML = "";
  for (const element of [document.documentElement, document.body]) element.removeAttribute("style");
});

it("adds a classic scrollbar's height when the page scrolls sideways", () => {
  const page = { natural: 800, height: 1000, frame: 400, bar: 15 };
  expect(frameDocument(page).measure(false)).toEqual({ height: 1015, wide: true });
  // Fitted, it does not scroll and has no scrollbar.
  expect(frameDocument(page).measure(true)).toEqual({ height: 500, wide: true });
  expect(frameDocument({ ...page, natural: 2000 }).measure(true)).toEqual({
    height: 415,
    wide: true,
  });
});

it("keeps a page that fits at its left edge", () => {
  const { doc, measure } = frameDocument({ natural: 800, height: 1000, frame: 400 });
  const root = doc.documentElement;
  measure(false);
  root.scrollLeft = 300;
  keepLeftEdge(doc);
  // At 100% the sideways scroll is the reader's own.
  expect(root.scrollLeft).toBe(300);
  measure(true);
  expect(root.scrollLeft).toBe(0);
  // scrollIntoView can scroll the hidden axis; the scroll handler puts it back.
  root.scrollLeft = 12;
  keepLeftEdge(doc);
  expect(root.scrollLeft).toBe(0);
});

it("moves the page's own vertical scroll to the pane that scrolls the frame", () => {
  const pane = document.createElement("div");
  pane.style.overflowY = "auto";
  const box = document.createElement("div");
  const iframe = document.createElement("iframe");
  box.append(iframe);
  pane.append(box);
  document.body.append(pane);
  const doc = document.implementation.createHTMLDocument("mail");
  const root = doc.documentElement;
  let top = 0;
  Object.defineProperty(root, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  pane.scrollTop = 100;
  // Nothing scrolled inside the frame: the pane stays put.
  keepTopEdge(iframe, doc, frameScrollTop(doc));
  expect(pane.scrollTop).toBe(100);
  // A find hit scrolled the page 1345 px inside a frame that has since grown.
  root.scrollTop = 1345;
  keepTopEdge(iframe, doc, frameScrollTop(doc));
  expect(root.scrollTop).toBe(0);
  expect(pane.scrollTop).toBe(1445);
  pane.remove();
});

it("lets a page wider than the smallest scale scroll by what is left over", () => {
  const { doc, measure } = frameDocument({ natural: 2000, height: 1000, frame: 400 });
  const root = doc.documentElement;
  expect(measure(true)).toEqual({ height: 400, wide: true });
  expect(root.style.zoom).toBe(String(MIN_FIT_SCALE));
  expect(root.scrollWidth).toBe(800);
  expect(root.style.overflowX).toBe("auto");
});

it("reports mail that fits as not wide and hides sub-pixel overflow", () => {
  const { doc, measure } = frameDocument({ natural: 400.6, height: 700, frame: 400 });
  expect(measure(true)).toEqual({ height: 700, wide: false });
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
