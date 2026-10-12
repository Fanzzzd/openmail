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

/** The scale that fits content of `contentWidth` into `frameWidth`; 1 when it already fits. */
export function fitScale(contentWidth: number, frameWidth: number): number {
  if (frameWidth <= 0 || contentWidth <= frameWidth + 1) return 1;
  return Math.max(MIN_FIT_SCALE, frameWidth / contentWidth);
}

/**
 * How a page `natural` px wide sits in a frame `frame` px wide: its scale,
 * whether it is wider than the frame, and whether the frame scrolls sideways.
 * The frame scrolls only when the scaled page is still wider by more than a
 * pixel, so fractional widths never leave a sliver to scroll.
 */
export function fitLayout(natural: number, frame: number, fit: boolean) {
  const scale = fit ? fitScale(natural, frame) : 1;
  return { scale, wide: natural > frame + 1, scrolls: natural * scale > frame + 1 };
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
  for (const property of FIT_PROPERTIES) root.style.removeProperty(property);
  const natural = root.scrollWidth;
  const { scale, wide, scrolls } = fitLayout(natural, root.clientWidth, fit);
  // Mail styles can neither hide the sideways overflow nor add some.
  root.style.setProperty("overflow-x", scrolls ? "auto" : "hidden", "important");
  // A page scrolled sideways at 100% would stay shifted once it fits.
  if (!scrolls) (doc.scrollingElement ?? root).scrollLeft = 0;
  if (scale === 1) return { height: root.scrollHeight, wide };
  root.style.setProperty("width", `${natural}px`, "important");
  // Measured at the natural width but before scaling: a page sized to the
  // frame (html { height: 100% }) would otherwise shrink the frame every pass.
  const height = Math.ceil(root.scrollHeight * scale);
  root.style.setProperty("zoom", String(scale), "important");
  return { height, wide };
}
