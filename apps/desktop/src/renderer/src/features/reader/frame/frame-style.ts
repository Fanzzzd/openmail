/** Styles and layout the reader applies to a mail frame from outside it. */

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
 * page down to the frame, as Apple Mail does. The page keeps the width it was
 * designed for, so its tables and columns do not reflow. Returns the frame
 * height the page needs and whether the page is wider than the frame.
 *
 * The scale is CSS `zoom`, not a transform: a transform leaves the page's
 * layout width at its natural size, so the frame scrolled sideways into blank
 * space past the scaled page.
 */
export function fitDocument(doc: Document, fit: boolean): { height: number; wide: boolean } {
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
  return { height: pageHeight(root) + bar, wide };
}

/**
 * The page's height in frame pixels, once scaled. scrollHeight is never less
 * than the frame, so it cannot tell that a page got shorter; the root's box
 * can, as pinFrameLayout sizes it to its content. Content that overflows the
 * root's box is counted only while the page is taller than the frame.
 */
function pageHeight(root: HTMLElement): number {
  const box = Math.ceil(root.getBoundingClientRect().height);
  return root.scrollHeight > root.clientHeight + 1 ? Math.max(box, root.scrollHeight) : box;
}

/**
 * Overrides mail styles that would fight the reader's sizing. The frame takes
 * its height from the page, so a page that takes its height from the frame
 * (`html, body { height: 100% }`, `min-height: 100vh`) would grow the frame
 * by its padding or margin on every resize. The page scrolls in the thread,
 * not inside the frame, and never sideways past what fitDocument allows.
 */
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

/** How many times in a row the frame may grow with nothing new in the page. */
export const MAX_UNPROMPTED_GROWTH = 8;

/**
 * Bounds the frame's growth when content still follows the frame's height
 * (an element with `height: 100vh` plus a margin): each resize would make the
 * page taller again. The frame grows at most `limit` times between refills,
 * which the reader calls when the page itself changes: its DOM, a loaded image
 * or font, or the frame's width. Shrinking is always taken.
 */
export function growthGuard(limit = MAX_UNPROMPTED_GROWTH) {
  let left = limit;
  return {
    refill: () => {
      left = limit;
    },
    /** The height to use, given the frame's current height and the measured one. */
    next: (current: number, measured: number): number => {
      if (measured <= current) return measured;
      if (left === 0) return current;
      left--;
      return measured;
    },
  };
}

/** Puts a page that must not scroll sideways back at its left edge, e.g. after scrollIntoView. */
export function keepLeftEdge(doc: Document): void {
  const scroller = doc.scrollingElement ?? doc.documentElement;
  if (doc.documentElement.style.overflowX === "hidden" && scroller.scrollLeft !== 0)
    scroller.scrollLeft = 0;
}
