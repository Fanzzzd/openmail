/**
 * Smooth scrolling, except with Reduce Motion on (System Settings →
 * Accessibility → Display, or the browser's equivalent): then it jumps.
 * Use it for every programmatic smooth scroll.
 */
export function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduce ? "auto" : "smooth";
}
