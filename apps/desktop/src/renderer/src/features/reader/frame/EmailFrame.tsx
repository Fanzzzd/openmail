import {
  READER_BASE_CSS,
  READER_COLOURS,
  linkHint,
  linkNeedsConfirmation,
} from "@openmail/core/schema";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useRunMail } from "../../../state/mail";
import { openMailLink } from "../../../state/desktop";
import { prefsAtom } from "../../../state/queries";
import { LinkConfirmDialog } from "./LinkConfirmDialog";
import type { QuoteHistory } from "@openmail/core/schema";
import { listenForMessageActivation } from "./message-activation";
import { useLingui } from "@lingui/react/macro";
import { constVoid } from "effect/Function";
import { useBodyQuotes } from "../body/body-quotes";
import { presentBody } from "../body/body-text";
import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from "react";
import { externalLinkTargets, frameLinkTarget, listenForLinkHints } from "./email-links";
import { sanitizeReaderHtml } from "./reader-html";
import { isTypingTarget } from "../../../lib/typing-target";
import {
  DARK_CSS,
  frameScrollTop,
  keepLeftEdge,
  keepTopEdge,
  measureFrame,
  pinFrameLayout,
} from "./frame-style";
import { FRAME_INITIAL_HEIGHT, frameSurface, type MessageBackground } from "../body/frame-surface";
import { HIGHLIGHT_CSS, useSearchHits } from "../../search";

// Mail HTML is untrusted. It renders in a sandboxed iframe with scripts off,
// and its own CSP blocks remote loads (tracking pixels) until images are
// allowed for the message. Known trackers are stripped from the HTML before it
// gets here (`prepareMessageHtml`), so allowing images never loads them.
// `allow-same-origin` only lets this component measure and fit the document
// and listen for shortcut keys; without `allow-scripts` the mail cannot use it.
// The resource policy is also the baseline checked by the mobile reader.
// Stylesheets never load from the network: a fetched sheet's own url() and
// @import would skip the tracker and pixel filters that the mail's HTML went through.
const BLOCKED = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";
const ALLOWED =
  "default-src 'none'; img-src data: cid: https:; style-src 'unsafe-inline'; font-src data: https:";
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
  const cleanLinks = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null)?.cleanLinks;
  const openLink = (url: string) => run(openMailLink(url, cleanLinks !== false));

  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const quotes = useBodyQuotes(frameDocument, previous);
  const hasQuotes = !!quotes?.length;
  const [showQuotes, setShowQuotes] = useState(false);
  const activate = useRef(onActivate);
  useEffect(() => {
    activate.current = onActivate;
  });
  const { present: presentHits } = useSearchHits();
  // Set by the measuring effect: measures on the next animation frame.
  const remeasure = useRef<() => void>(constVoid);
  // The current find hit, scrolled to again once the frame has grown to its page.
  const reveal = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!frameDocument || !quotes) return constVoid;
    const view = presentBody(frameDocument.body, quotes, showQuotes, findQuery);
    // Search hits count after the quotes settle; an open find scrolls last.
    const hits = presentHits(frameDocument.body);
    onMatches?.(view.count);
    const index = view.count ? findIndex % view.count : 0;
    view.select(index);
    if (view.count) {
      reveal.current = () => view.select(index);
      remeasure.current();
    }
    return () => {
      reveal.current = null;
      view.dispose();
      hits();
    };
  }, [frameDocument, quotes, showQuotes, findQuery, findIndex, onMatches, presentHits]);
  const [fit, setFit] = useState(true);
  const [wide, setWide] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Size the frame to its page so the thread scrolls as one page (see
  // frame-style.ts for the rule). Anything that can change the page re-measures,
  // at most once per animation frame. It cannot loop: measuring writes the
  // box's height, which the next reading does not depend on, and the root's
  // zoom, width and overflow-x, which are outside the observed body and come
  // out the same when measured again. A find or selection jump that scrolled
  // the page inside the frame scrolls the pane instead once the frame has grown.
  useEffect(() => {
    const frame = frameRef.current;
    const box = boxRef.current;
    if (!frameDocument || !frame || !box) return constVoid;
    let request = 0;
    const measure = () => {
      request = 0;
      const top = frameScrollTop(frameDocument);
      const size = measureFrame(frame, frameDocument, fit);
      box.style.height = `${size.height}px`;
      setWide(size.wide);
      keepTopEdge(frame, frameDocument, top);
      // Centred in the pane, now that the frame is as tall as its page.
      const hit = reveal.current;
      reveal.current = null;
      hit?.();
    };
    const schedule = () => {
      request ||= requestAnimationFrame(measure);
    };
    remeasure.current = schedule;
    measure();
    // The frame's width, and layout changes nothing else reports.
    const observer = new ResizeObserver(schedule);
    for (const element of [frame, frameDocument.documentElement, frameDocument.body])
      observer.observe(element);
    // Quotes, and late images and web fonts.
    const mutations = new MutationObserver(schedule);
    mutations.observe(frameDocument.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    for (const type of ["load", "error"]) frameDocument.addEventListener(type, schedule, true);
    frameDocument.fonts.addEventListener("loadingdone", schedule);
    // A jump that scrolled the page inside the frame.
    const scrolled = () => {
      if (frameScrollTop(frameDocument) > 0) schedule();
    };
    frameDocument.addEventListener("scroll", scrolled);
    return () => {
      remeasure.current = constVoid;
      frameDocument.removeEventListener("scroll", scrolled);
      cancelAnimationFrame(request);
      observer.disconnect();
      mutations.disconnect();
      for (const type of ["load", "error"]) frameDocument.removeEventListener(type, schedule, true);
      frameDocument.fonts.removeEventListener("loadingdone", schedule);
    };
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
      : `${READER_BASE_CSS}${background === "dark" ? DARK_CSS : ""} body { zoom: ${zoom}%; }${HIGHLIGHT_CSS}`;
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
    // measureFrame sets overflow-x: the page scrolls sideways only when there is
    // more of it to show. No rubber band or sideways scroll chaining either.
    pinFrameLayout(frameDoc);
    const keydown = (event: KeyboardEvent) => {
      if (event.isTrusted && !isTypingTarget(frameDoc.activeElement)) keys.current?.(event);
    };
    frameDoc.addEventListener("keydown", keydown);
    // Find and selection jumps call scrollIntoView, which scrolls a hidden axis too.
    const scroll = () => keepLeftEdge(frameDoc);
    frameDoc.addEventListener("scroll", scroll);
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
      frameDoc.removeEventListener("scroll", scroll);
      stopActivation();
    };
  };

  return (
    <div onMouseLeave={() => setHint(null)} className={frameSurface(background)}>
      <div ref={boxRef} style={{ height: FRAME_INITIAL_HEIGHT }}>
        <iframe
          ref={frameRef}
          title={t`Message`}
          onLoad={onLoad}
          sandbox="allow-same-origin"
          srcDoc={doc}
          className="block h-full w-full border-0"
        />
      </div>
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
        <output className="pointer-events-none fixed right-3 bottom-3 left-3 z-50 w-fit max-w-[calc(100%-1.5rem)] rounded border border-edge bg-neutral-100 px-2 py-1 font-mono text-footnote break-all text-neutral-800 shadow dark:bg-neutral-800 dark:text-neutral-100">
          {linkHint(link)}
        </output>
      )}
    </div>
  );
}
