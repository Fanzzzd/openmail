import type { QuoteHistory } from "@openmail/core/schema";
import { listenForMessageActivation } from "./message-activation";
import { useLingui } from "@lingui/react/macro";
import { constVoid } from "effect/Function";
import { useBodyQuotes } from "./body-quotes";
import { presentBody } from "./body-text";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { externalLinkTargets, frameLinkTarget, listenForLinkHints } from "./email-links";

// Mail HTML is untrusted. It renders in a sandboxed iframe with scripts off,
// and its own CSP blocks remote loads (tracking pixels) until images are
// allowed for the message. Known trackers are stripped from the HTML before it
// gets here (`prepareMessageHtml`), so allowing images never loads them.
// `allow-same-origin` only lets this component measure the document and
// listen for shortcut keys; without `allow-scripts` the mail cannot use it.
// The resource policy is also the baseline checked by the mobile reader.
const BLOCKED = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";
const ALLOWED =
  "default-src 'none'; img-src data: cid: https:; style-src 'unsafe-inline' https:; font-src data: https:";
const FRAME_RESTRICTIONS =
  "script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";

const BASE_CSS = `
  html, body { margin: 0; padding: 0; }
  html { background: #fff; overflow-x: auto !important; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
         overflow: visible !important; color: #1f1f1f; word-wrap: break-word; overflow-wrap: anywhere; }
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
  onActivate: () => void;
  previous: QuoteHistory;
  findQuery: string;
  findIndex: number;
  onMatches: ((count: number) => void) | undefined;
}

export function EmailFrame({
  html,
  remote,
  background,
  zoom,
  onKeyDown,
  onActivate,
  previous,
  findQuery,
  findIndex,
  onMatches,
}: Props) {
  const { t } = useLingui();
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const quotes = useBodyQuotes(frameDocument, previous);
  const hasQuotes = !!quotes?.length;
  const [showQuotes, setShowQuotes] = useState(false);
  const activate = useRef(onActivate);
  useEffect(() => {
    activate.current = onActivate;
  });
  useEffect(() => {
    if (!frameDocument || !quotes) return constVoid;
    const view = presentBody(frameDocument.body, quotes, showQuotes, findQuery);
    onMatches?.(view.count);
    view.select(view.count ? findIndex % view.count : 0);
    return () => view.dispose();
  }, [frameDocument, quotes, showQuotes, findQuery, findIndex, onMatches]);
  const [height, setHeight] = useState(120);
  const [hint, setHint] = useState<{ document: string; url: string | null } | null>(null);
  const dispose = useRef<(() => void) | undefined>(undefined);
  const observer = useRef<ResizeObserver | null>(null);
  const keys = useRef(onKeyDown);
  useEffect(() => {
    keys.current = onKeyDown;
  });

  const css = `${BASE_CSS}${background === "dark" ? DARK_CSS : ""} body { zoom: ${zoom}%; }`;
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${remote ? ALLOWED : BLOCKED}; ${FRAME_RESTRICTIONS}">
<base target="_blank"><style>${css}</style></head><body>${html}</body></html>`;

  useEffect(
    () => () => {
      observer.current?.disconnect();
      dispose.current?.();
    },
    [],
  );

  const link = hint?.document === doc ? hint.url : null;

  // Size the frame to its content so the thread scrolls as one page. Late
  // images and web fonts change the height after load, hence the observer.
  const onLoad = (e: SyntheticEvent<HTMLIFrameElement>) => {
    dispose.current?.();
    observer.current?.disconnect();
    const frameDoc = e.currentTarget.contentDocument;
    const root = frameDoc?.documentElement;
    if (!frameDoc || !root || frameDoc.URL !== "about:srcdoc") return;
    setFrameDocument(frameDoc);
    externalLinkTargets(frameDoc);
    // Mail styles cannot hide the viewport's horizontal overflow.
    root.style.setProperty("overflow-x", "auto", "important");
    frameDoc.body.style.setProperty("overflow", "visible", "important");
    setHeight(root.scrollHeight);
    observer.current = new ResizeObserver(() => setHeight(root.scrollHeight));
    observer.current.observe(root);
    const keydown = (event: KeyboardEvent) => {
      if (
        event.isTrusted &&
        !frameDoc.activeElement?.closest("input,textarea,select,[contenteditable]")
      )
        keys.current?.(event);
    };
    frameDoc.addEventListener("keydown", keydown);
    const stopActivation = listenForMessageActivation(frameDoc, () => activate.current());
    const stopHints = listenForLinkHints(
      frameDoc,
      (event) => frameLinkTarget(frameDoc, event),
      (url) => setHint({ document: doc, url }),
    );
    dispose.current = () => {
      stopHints();
      frameDoc.removeEventListener("keydown", keydown);
      stopActivation();
    };
  };

  return (
    <div
      onMouseLeave={() => setHint(null)}
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
      {hasQuotes && (
        <button
          type="button"
          className="mt-2 text-a11y-accent"
          onClick={() => setShowQuotes(!showQuotes)}
        >
          {showQuotes ? t`Hide quoted text` : t`Show quoted text`}
        </button>
      )}
      {link && (
        <output className="pointer-events-none fixed right-3 bottom-3 left-3 z-50 w-fit max-w-[calc(100%-1.5rem)] rounded border border-black/10 bg-neutral-100 px-2 py-1 font-mono text-[12px] break-all text-neutral-800 shadow dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100">
          {link}
        </output>
      )}
    </div>
  );
}
