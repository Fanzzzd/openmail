/**
 * The part of the layout viewport a phone shows, as CSS variables on <html>:
 * `--visual-top` is how far the browser scrolled it down, `--keyboard-inset`
 * how much of its bottom the on-screen keyboard covers. iOS Safari keeps fixed
 * elements sized to the layout viewport, so a full-screen sheet uses these to
 * keep its footer (Send) above the keyboard. Both stay 0 while pinch-zoomed.
 */
export function keyboardInsets(viewport: {
  height: number;
  offsetTop: number;
  scale: number;
  layoutHeight: number;
}) {
  if (Math.abs(viewport.scale - 1) > 0.01) return { top: 0, bottom: 0 };
  const top = Math.max(0, Math.round(viewport.offsetTop));
  const bottom = Math.max(0, Math.round(viewport.layoutHeight - viewport.height - top));
  return { top, bottom };
}

/** Follows the visual viewport for the rest of the page's life. */
export function trackKeyboardInset(win: Window) {
  const viewport = win.visualViewport;
  if (!viewport) return;
  const root = win.document.documentElement;
  const update = () => {
    const { top, bottom } = keyboardInsets({
      height: viewport.height,
      offsetTop: viewport.offsetTop,
      scale: viewport.scale,
      layoutHeight: win.innerHeight,
    });
    root.style.setProperty("--visual-top", `${top}px`);
    root.style.setProperty("--keyboard-inset", `${bottom}px`);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
}
