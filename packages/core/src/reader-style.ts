/** Colours shared by the renderer and the browser-free visibility model. */
export const READER_COLOURS = {
  paper: "#fff",
  ink: "#1f1f1f",
  link: "#2563eb",
  focus: "#1d4ed8",
  markPaper: "#ff0",
  markInk: "#000",
} as const;

// :where keeps the UA mark defaults below any mail rule of equal specificity.
export const READER_COLOUR_CSS = `
  html { background: ${READER_COLOURS.paper}; }
  body { color: ${READER_COLOURS.ink}; }
  a { color: ${READER_COLOURS.link}; }
  a:focus-visible { outline: 2px solid ${READER_COLOURS.focus}; outline-offset: 2px; }
  :where(mark) { background-color: ${READER_COLOURS.markPaper}; color: ${READER_COLOURS.markInk}; }
`;
export const READER_BASE_CSS = `
  ${READER_COLOUR_CSS}
  html, body { margin: 0; padding: 0; }
  html { overflow-x: auto !important; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
         overflow: visible !important; word-wrap: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`;
