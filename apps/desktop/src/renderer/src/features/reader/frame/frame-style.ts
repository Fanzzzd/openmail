/**
 * Styles and layout the reader applies to a mail frame from outside it.
 *
 * The rule: the frame is as tall as the page's full layout extent (every box,
 * overflow and positioned descendants included) at the frame's width after
 * fit-zoom, read with the iframe collapsed to 0 px so no viewport-relative
 * size can follow the frame's height. The reading is then a function of width
 * and content only, so setting the height cannot change the next reading and
 * one measure reaches the fixed point. The page scrolls sideways only while
 * the zoomed page is still more than 1 px wider than the frame.
 */

/** Elements whose colors are pictures: inverted back in dark mode so photos and logos look right. */
export const PICTURES = [
  "img",
  "video",
  "picture",
  "svg image",
  "[background]",
  '[style*="background" i][style*="url(" i]',
].join(", ");

/**
 * Dark background for mail designed for white: invert the page, then invert
 * pictures back. A picture inside another picture is already back to its own
 * colors, so it is left alone; otherwise it would end up inverted again.
 */
export const DARK_CSS = `
  html { filter: invert(1) hue-rotate(180deg); }
  :is(${PICTURES}) { filter: invert(1) hue-rotate(180deg); }
  :is(${PICTURES}) :is(${PICTURES}) { filter: none; }
`;

/** Wide mail shrinks at most this far; past it the message scrolls sideways instead. */
export const MIN_FIT_SCALE = 0.4;

/**
 * How a page `natural` px wide sits in a frame `frame` px wide: its scale,
 * whether it is wider than the frame, and whether the frame scrolls sideways.
 * A pixel or less of overflow, from fractional widths, counts as fitting, so
 * it neither scales the page nor leaves a sliver to scroll.
 */
export function fitLayout(natural: number, frame: number, fit: boolean) {
  const wide = frame > 0 && natural > frame + 1;
  const scale = fit && wide ? Math.max(MIN_FIT_SCALE, frame / natural) : 1;
  return { scale, wide, scrolls: wide && natural * scale > frame + 1 };
}

const FIT_PROPERTIES = ["width", "zoom"] as const;

/**
 * Lays the mail out at its own width and, when `fit` is on, scales the whole
 * page down to the frame, as Apple Mail does, so its tables and columns do not
 * reflow. Returns the frame height the page needs and whether the page is
 * wider than the frame.
 *
 * The scale is CSS `zoom`, not a transform: a transform leaves the page's
 * layout width at its natural size, so the frame scrolled sideways into blank
 * space past the scaled page.
 *
 * Writes only the root's width, zoom and overflow-x, and the iframe's height,
 * which it collapses to 0 px for the reading and then clears; the iframe fills
 * a box that keeps the thread's layout and scroll position meanwhile. With the
 * frame collapsed, `scrollHeight` is never padded up to the frame's height and
 * covers every box the page can scroll to. `html { overflow-y: hidden }` and
 * `height: auto` come from pinFrameLayout; the sanitizer turns `vh` into px.
 */
export function measureFrame(
  frame: HTMLIFrameElement,
  doc: Document,
  fit: boolean,
): { height: number; wide: boolean } {
  const root = doc.documentElement;
  const view = doc.defaultView;
  for (const property of FIT_PROPERTIES) root.style.removeProperty(property);
  // The mail's own html { zoom } is kept and multiplied by the fit scale.
  const own = Number.parseFloat(view?.getComputedStyle(root).zoom ?? "") || 1;
  const natural = root.scrollWidth;
  const { scale, wide, scrolls } = fitLayout(natural, root.clientWidth, fit);
  // Mail styles can neither hide the sideways overflow nor add some.
  root.style.setProperty("overflow-x", scrolls ? "auto" : "hidden", "important");
  // A page scrolled sideways at 100% would stay shifted once it fits.
  if (!scrolls) (doc.scrollingElement ?? root).scrollLeft = 0;
  if (scale !== 1) {
    root.style.setProperty("width", `${natural / own}px`, "important");
    root.style.setProperty("zoom", String(own * scale), "important");
  }
  // A classic (non-overlay) scrollbar takes its height from the frame.
  const bar = scrolls && view ? Math.max(0, view.innerHeight - root.clientHeight) : 0;
  frame.style.height = "0px";
  // scrollHeight rounds; the root's own box, rounded up, keeps a fractional last line.
  const height = Math.max(root.scrollHeight, Math.ceil(root.getBoundingClientRect().height));
  frame.style.removeProperty("height");
  return { height: height + bar, wide };
}

/** Overrides mail styles that would size the page by the frame or scroll it inside the frame. */
export function pinFrameLayout(doc: Document): void {
  const root = doc.documentElement;
  for (const element of [root, doc.body]) {
    element.style.setProperty("height", "auto", "important");
    element.style.setProperty("min-height", "0", "important");
  }
  root.style.setProperty("overflow-y", "hidden", "important");
  root.style.setProperty("overscroll-behavior-x", "none", "important");
  doc.body.style.setProperty("overflow", "visible", "important");
}

/** Puts a page that must not scroll sideways back at its left edge, e.g. after scrollIntoView. */
export function keepLeftEdge(doc: Document): void {
  const scroller = doc.scrollingElement ?? doc.documentElement;
  if (doc.documentElement.style.overflowX === "hidden" && scroller.scrollLeft !== 0)
    scroller.scrollLeft = 0;
}
