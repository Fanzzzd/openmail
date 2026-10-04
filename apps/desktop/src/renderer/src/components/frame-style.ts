/** Styles and layout the reader applies to a mail frame from outside it. */

/** Elements whose colors are pictures: inverted back in dark mode so photos and logos look right. */
export const PICTURES = [
  "img",
  "video",
  "picture",
  "svg",
  "[background]",
  '[style*="background" i][style*="url(" i]',
  '[style*="background" i][style*="gradient(" i]',
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

const FIT_PROPERTIES = ["width", "transform", "transform-origin"] as const;

/**
 * Lays the mail out at its own width and, when `fit` is on, scales the whole
 * page down to the frame, as Apple Mail does. The page keeps the width it was
 * designed for, so its tables and columns do not reflow. Returns the frame
 * height the page needs and whether the page is wider than the frame.
 */
export function fitDocument(doc: Document, fit: boolean): { height: number; wide: boolean } {
  const root = doc.documentElement;
  for (const property of FIT_PROPERTIES) root.style.removeProperty(property);
  const natural = root.scrollWidth;
  const frame = root.clientWidth;
  const scale = fit ? fitScale(natural, frame) : 1;
  if (scale === 1) return { height: root.scrollHeight, wide: natural > frame + 1 };
  root.style.setProperty("width", `${natural}px`, "important");
  root.style.setProperty("transform", `scale(${scale})`, "important");
  root.style.setProperty("transform-origin", "0 0", "important");
  return { height: Math.ceil(root.getBoundingClientRect().height), wide: true };
}
