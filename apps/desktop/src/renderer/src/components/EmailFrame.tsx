import {
  READER_BASE_CSS,
  READER_COLOURS,
  linkHint,
  linkNeedsConfirmation,
} from "@openmail/core/schema";
import { useRunMail, withMail } from "../state/mail";
import { LinkConfirmDialog } from "./LinkConfirmDialog";
import type { QuoteHistory } from "@openmail/core/schema";
import { listenForMessageActivation } from "./message-activation";
import { useLingui } from "@lingui/react/macro";
import { constVoid } from "effect/Function";
import { useBodyQuotes } from "./body-quotes";
import { presentBody } from "./body-text";
import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from "react";
import { externalLinkTargets, frameLinkTarget, listenForLinkHints } from "./email-links";
import { sanitizeReaderHtml } from "./reader-html";
import { isTypingTarget } from "../typing-target";
import { DARK_CSS, fitDocument } from "./frame-style";
import { FRAME_INITIAL_HEIGHT, frameSurface, type MessageBackground } from "./MessageBodyShell";

// Mail HTML is untrusted. It renders in a sandboxed iframe with scripts off,
// and its own CSP blocks remote loads (tracking pixels) until images are
// allowed for the message. Known trackers are stripped from the HTML before it
// gets here (`prepareMessageHtml`), so allowing images never loads them.
// `allow-same-origin` only lets this component measure and fit the document
// and listen for shortcut keys; without `allow-scripts` the mail cannot use it.
// The resource policy is also the baseline checked by the mobile reader.
const BLOCKED = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";
const ALLOWED =
  "default-src 'none'; img-src data: cid: https:; style-src 'unsafe-inline' https:; font-src data: https:";
const FRAME_RESTRICTIONS =
  "script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";

interface Props {
  presentation?: "reader" | "compose";
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
  presentation = "reader",
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
  const { t, i18n } = useLingui();
  const confirmedAnchor = useRef<HTMLElement | null>(null);
  const run = useRunMail();
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const openLink = (url: string) => run(withMail((call) => call("OpenMailLink", { url })));

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
  const [height, setHeight] = useState(FRAME_INITIAL_HEIGHT);
  const [fit, setFit] = useState(true);
  const [wide, setWide] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Size the frame to its content so the thread scrolls as one page. Late
  // images and web fonts change the page after load and the pane can resize,
  // hence the observer on both.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frameDocument || !frame) return constVoid;
    const measure = () => {
      const size = fitDocument(frameDocument, fit);
      setHeight(size.height);
      setWide(size.wide);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frameDocument.documentElement);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameDocument, fit]);
  const [hint, setHint] = useState<{ document: string; url: string | null } | null>(null);
  const dispose = useRef<(() => void) | undefined>(undefined);
  const keys = useRef(onKeyDown);
  useEffect(() => {
    keys.current = onKeyDown;
  });

  const css =
    presentation === "compose"
      ? `html, body { background: ${READER_COLOURS.paper}; color: ${READER_COLOURS.ink}; color-scheme: light; }`
      : `${READER_BASE_CSS}${background === "dark" ? DARK_CSS : ""} body { zoom: ${zoom}%; }`;
  const safeHtml = useMemo(() => sanitizeReaderHtml(html, remote), [html, remote]);
  const doc = `<!doctype html><html lang="${i18n.locale}"><head><meta charset="utf-8">
<meta http-equiv="x-dns-prefetch-control" content="off">
<meta http-equiv="Content-Security-Policy" content="${remote ? ALLOWED : BLOCKED}; ${FRAME_RESTRICTIONS}">
<base target="_blank"><style>${css}</style></head><body dir="auto">${safeHtml}</body></html>`;

  useEffect(() => () => dispose.current?.(), []);

  const link = hint?.document === doc ? hint.url : null;

  const onLoad = (e: SyntheticEvent<HTMLIFrameElement>) => {
    dispose.current?.();
    const frameDoc = e.currentTarget.contentDocument;
    const root = frameDoc?.documentElement;
    if (!frameDoc || !root || frameDoc.URL !== "about:srcdoc") return;
    setFrameDocument(frameDoc);
    externalLinkTargets(frameDoc);
    // Mail styles cannot hide the viewport's horizontal overflow.
    root.style.setProperty("overflow-x", "auto", "important");
    root.style.setProperty("overflow-y", "hidden", "important");
    frameDoc.body.style.setProperty("overflow", "visible", "important");
    const keydown = (event: KeyboardEvent) => {
      if (event.isTrusted && !isTypingTarget(frameDoc.activeElement)) keys.current?.(event);
    };
    frameDoc.addEventListener("keydown", keydown);
    const stopActivation = listenForMessageActivation(frameDoc, () => activate.current());
    const click = (event: MouseEvent) => {
      event.preventDefault();
      const element =
        event.target instanceof (frameDoc.defaultView?.Element ?? Element) ? event.target : null;
      const anchor = element?.closest("a,area");
      if (!anchor || !event.isTrusted || (event.type === "auxclick" && event.button !== 1)) return;
      const url = frameLinkTarget(frameDoc, event);
      if (!url) return;
      const label =
        anchor instanceof (frameDoc.defaultView?.HTMLElement ?? HTMLElement)
          ? anchor.innerText || anchor.getAttribute("alt") || ""
          : anchor.textContent;
      if (linkNeedsConfirmation(url, label)) {
        confirmedAnchor.current =
          anchor instanceof (frameDoc.defaultView?.HTMLElement ?? HTMLElement) ? anchor : null;
        setPendingLink(url);
      } else openLink(url);
    };
    frameDoc.addEventListener("click", click);
    frameDoc.addEventListener("auxclick", click);
    const stopHints = listenForLinkHints(
      frameDoc,
      (event) => frameLinkTarget(frameDoc, event),
      (url) => setHint({ document: doc, url }),
    );
    dispose.current = () => {
      stopHints();
      frameDoc.removeEventListener("click", click);
      frameDoc.removeEventListener("auxclick", click);
      frameDoc.removeEventListener("keydown", keydown);
      stopActivation();
    };
  };

  return (
    <div onMouseLeave={() => setHint(null)} className={frameSurface(background)}>
      <iframe
        ref={frameRef}
        title={t`Message`}
        onLoad={onLoad}
        sandbox="allow-same-origin"
        srcDoc={doc}
        style={{ height }}
        className="block w-full border-0"
      />
      {wide && (
        <button type="button" onClick={() => setFit(!fit)} className="mt-2 mr-4 text-a11y-accent">
          {fit ? t`View at 100%` : t`Fit to width`}
        </button>
      )}
      {pendingLink && (
        <LinkConfirmDialog
          url={pendingLink}
          onClose={() => setPendingLink(null)}
          onOpen={openLink}
          returnFocus={() => confirmedAnchor.current}
        />
      )}
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
          {linkHint(link)}
        </output>
      )}
    </div>
  );
}
