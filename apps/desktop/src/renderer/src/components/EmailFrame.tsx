import { type SyntheticEvent, useEffect, useRef, useState } from "react";

// Mail HTML is untrusted. It renders in a sandboxed iframe with scripts off,
// and its own CSP blocks remote loads (tracking pixels) until images are
// allowed for the message. Known trackers are stripped from the HTML before it
// gets here (`prepareMessageHtml`), so allowing images never loads them.
// `allow-same-origin` only lets this component measure the document and
// listen for shortcut keys; without `allow-scripts` the mail cannot use it.
const BLOCKED = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";
const ALLOWED =
  "default-src 'none'; img-src data: cid: https: http:; style-src 'unsafe-inline' https:; font-src data: https:";

const BASE_CSS = `
  html, body { margin: 0; padding: 0; }
  html { background: #fff; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
         color: #1f1f1f; word-wrap: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  a { color: #2563eb; }
`;

// Dark background for mail designed for white: invert the page, then invert
// pictures back so photos and logos keep their colors.
const DARK_CSS = `
  html { filter: invert(1) hue-rotate(180deg); }
  img, video, picture, svg, [background], [style*="background-image"], [style*="background:url"],
  [style*="background: url"] { filter: invert(1) hue-rotate(180deg); }
`;

export type MessageBackground = "light" | "dark";

interface Props {
  /** Prepared HTML: trackers stripped, inline images resolved. */
  html: string;
  /** Remote images may load. */
  remote: boolean;
  background: MessageBackground;
  /** Text size in percent. */
  zoom: number;
  /** Keys pressed while the message itself has focus; the frame's document does not bubble to ours. */
  onKeyDown?: (event: KeyboardEvent) => void;
}

export function EmailFrame({ html, remote, background, zoom, onKeyDown }: Props) {
  const [height, setHeight] = useState(120);
  const observer = useRef<ResizeObserver | null>(null);
  const keys = useRef(onKeyDown);
  useEffect(() => {
    keys.current = onKeyDown;
  });

  const css = `${BASE_CSS}${background === "dark" ? DARK_CSS : ""} body { zoom: ${zoom}%; }`;
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${remote ? ALLOWED : BLOCKED}">
<base target="_blank"><style>${css}</style></head><body>${html}</body></html>`;

  useEffect(() => () => observer.current?.disconnect(), []);

  // Size the frame to its content so the thread scrolls as one page. Late
  // images and web fonts change the height after load, hence the observer.
  const onLoad = (e: SyntheticEvent<HTMLIFrameElement>) => {
    const frameDoc = e.currentTarget.contentDocument;
    const root = frameDoc?.documentElement;
    if (!frameDoc || !root) return;
    setHeight(root.scrollHeight);
    observer.current?.disconnect();
    observer.current = new ResizeObserver(() => setHeight(root.scrollHeight));
    observer.current.observe(root);
    frameDoc.addEventListener("keydown", (event) => keys.current?.(event));
  };

  return (
    <div
      className={`overflow-hidden rounded-lg p-4 ${
        background === "dark"
          ? "bg-black ring-1 ring-white/10"
          : "bg-white dark:ring-1 dark:ring-white/10"
      }`}
    >
      <iframe
        title="message"
        onLoad={onLoad}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ height }}
        className="block w-full border-0"
      />
    </div>
  );
}
