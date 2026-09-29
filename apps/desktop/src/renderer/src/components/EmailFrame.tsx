import { Trans } from "@lingui/react/macro";
import { ImageOff } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";

// Mail HTML is untrusted. It renders in a sandboxed iframe with scripts off,
// and its own CSP blocks remote loads (tracking pixels) until the user opts in
// per message. `allow-same-origin` only lets this component measure the
// document height; without `allow-scripts` the mail cannot use it.
const BLOCKED = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";
const ALLOWED =
  "default-src 'none'; img-src data: cid: https: http:; style-src 'unsafe-inline' https:; font-src data: https:";

const BASE_CSS = `
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
         color: #1f1f1f; word-wrap: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  a { color: #2563eb; }
`;

const REMOTE = /(<img[^>]+src=["']?https?:|url\(\s*["']?https?:|<link[^>]+href=["']?https?:)/i;

export function EmailFrame({ html }: { html: string }) {
  const [remote, setRemote] = useState(false);
  const [height, setHeight] = useState(120);
  const observer = useRef<ResizeObserver | null>(null);
  const hasRemote = REMOTE.test(html);

  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${remote ? ALLOWED : BLOCKED}">
<base target="_blank"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;

  useEffect(() => () => observer.current?.disconnect(), []);

  // Size the frame to its content so the thread scrolls as one page. Late
  // images and web fonts change the height after load, hence the observer.
  const onLoad = (e: SyntheticEvent<HTMLIFrameElement>) => {
    const root = e.currentTarget.contentDocument?.documentElement;
    if (!root) return;
    setHeight(root.scrollHeight);
    observer.current?.disconnect();
    observer.current = new ResizeObserver(() => setHeight(root.scrollHeight));
    observer.current.observe(root);
  };

  return (
    <div>
      {hasRemote && !remote && (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 text-[12px] text-neutral-600 dark:bg-white/5 dark:text-neutral-400">
          <ImageOff className="size-3.5" />
          <span className="flex-1">
            <Trans>Remote images are blocked so the sender can't tell if you read this.</Trans>
          </span>
          <button
            type="button"
            onClick={() => setRemote(true)}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            <Trans>Load images</Trans>
          </button>
        </div>
      )}
      {/* Mail is designed for white; keep it on white in dark mode too. */}
      <div className="overflow-hidden rounded-lg bg-white p-4 dark:ring-1 dark:ring-white/10">
        <iframe
          title="message"
          onLoad={onLoad}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          style={{ height }}
          className="block w-full border-0"
        />
      </div>
    </div>
  );
}
