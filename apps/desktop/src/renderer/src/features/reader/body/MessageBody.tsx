import { useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  EMPTY_QUOTE_HISTORY,
  htmlToText,
  normalizeQuote,
  orderThread,
  prepareMessageHtml,
  splitRepeatedQuote,
  type PreparedHtml,
  type QuoteHistory,
  type ReaderZoom,
} from "@openmail/core/schema";
import { constVoid } from "effect/Function";
import { AsyncResult, Atom } from "effect/reactivity";
import { ImageOff, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../../../../../shared/api";
import { inlineImagesAtom } from "../../../state/queries";
import { highlightBody } from "./body-text";
import { EmailFrame } from "../frame/EmailFrame";
import type { MessageBackground } from "./MessageBodyShell";
import { markPlainSearchHits, searchTermsOf, useSearchHits } from "../../search";
import { PickerPopover } from "../../../ui/Picker";

// Loaded through MessageBodyShell.tsx: everything here needs core's HTML cleaner.

export { EmailFrame };

const prepared = new WeakMap<Message, PreparedHtml>();
export function preparedHtml(m: Message): PreparedHtml {
  let value = prepared.get(m);
  if (!value) {
    value = prepareMessageHtml(m.bodyHtml);
    prepared.set(m, value);
  }
  return value;
}

const noInline = Atom.make(AsyncResult.success<Record<string, string>>({}));

/** Each message's earlier bodies in the thread, for folding repeated quotes. */
const quoteHistories = new WeakMap<readonly Message[], Map<string, QuoteHistory>>();
function quoteHistory(thread: readonly Message[], id: string): QuoteHistory {
  let histories = quoteHistories.get(thread);
  if (!histories) {
    const chronological = orderThread(thread, "oldest");
    const bodies = chronological.map((prior) =>
      normalizeQuote(prior.bodyText || htmlToText(prior.bodyHtml)),
    );
    histories = new Map(
      chronological.map((message, index) => [message.id, { bodies, before: index }]),
    );
    quoteHistories.set(thread, histories);
  }
  return histories.get(id) ?? EMPTY_QUOTE_HISTORY;
}

/** The remote image notice and the body of an expanded message. */
export function MessageBody({
  message: m,
  thread,
  remote,
  imageNotice,
  onLoadImages,
  onAlwaysLoad,
  background,
  zoom,
  onZoomKey,
  onActivate,
  findQuery,
  findIndex,
  onMatches,
}: {
  message: Message;
  /** Every stored message of the thread, shown or not. */
  thread: readonly Message[];
  remote: boolean;
  imageNotice: boolean;
  onLoadImages: () => void;
  onAlwaysLoad: (() => void) | undefined;
  background: MessageBackground;
  zoom: ReaderZoom;
  onZoomKey: (e: KeyboardEvent) => void;
  onActivate: () => void;
  findQuery: string;
  findIndex: number;
  onMatches: ((count: number) => void) | undefined;
}) {
  const plain = preparedHtml(m);
  // Embedded parts come from the cached message or the provider, never the sender's server.
  const inline = AsyncResult.getOrElse(
    useAtomValue(plain.hasCid ? inlineImagesAtom(m.id) : noInline),
    () => ({}),
  );
  const html = plain.hasCid ? prepareMessageHtml(m.bodyHtml, { inline }) : plain;
  const previous = quoteHistory(thread, m.id);
  return (
    <>
      <RemoteImagesNotice
        imageNotice={imageNotice}
        trackers={
          html.trackers.length + html.pixels > 0 ? (
            <TrackerBadge trackers={html.trackers} pixels={html.pixels} />
          ) : null
        }
        onLoadImages={onLoadImages}
        onAlwaysLoad={onAlwaysLoad}
      />

      <div className="pt-4">
        {m.bodyRefresh === "failed" && (
          <output className="mb-3 block text-a11y-muted">
            <Trans>Message text could not be refreshed. Showing the cached version.</Trans>
          </output>
        )}
        {m.bodyCached === false ? (
          <>
            <PlainBody
              text={m.bodyText || m.snippet}
              previous={previous}
              background={background}
              zoom={zoom}
              findQuery={findQuery}
              findIndex={findIndex}
              onMatches={onMatches}
            />
            <output className="block px-4 text-a11y-muted">
              <Trans>The body is not cached. Try opening this message again when connected.</Trans>
            </output>
          </>
        ) : m.bodyHtml ? (
          <EmailFrame
            html={html.html}
            remote={remote}
            background={background}
            zoom={zoom}
            onKeyDown={onZoomKey}
            onActivate={onActivate}
            previous={previous}
            findQuery={findQuery}
            findIndex={findIndex}
            onMatches={onMatches}
          />
        ) : (
          <PlainBody
            text={m.bodyText}
            previous={previous}
            background={background}
            zoom={zoom}
            findQuery={findQuery}
            findIndex={findIndex}
            onMatches={onMatches}
          />
        )}
      </div>
    </>
  );
}

/** "Blocked 2 trackers". Clicking it lists the services. */
function TrackerBadge({ trackers, pixels }: { trackers: readonly string[]; pixels: number }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const count = trackers.length + pixels;
  const unknown = plural(pixels, { one: "# tracking pixel", other: "# tracking pixels" });
  const list = [...trackers, ...(pixels > 0 ? [unknown] : [])];
  return (
    <PickerPopover
      aria-label={plural(count, { one: "Blocked # tracker", other: "Blocked # trackers" })}
      open={open}
      onOpenChange={setOpen}
      className="w-56"
      trigger={
        <button
          type="button"
          className="flex shrink-0 cursor-default items-center gap-1 rounded text-emerald-700 outline-offset-1 outline-a11y-focus focus-visible:outline-[3px] dark:text-emerald-400"
        >
          <ShieldCheck className="size-3.5" />
          {plural(count, { one: "Blocked # tracker", other: "Blocked # trackers" })}
        </button>
      }
    >
      <div className="px-3 py-2 text-[12px]">
        <span className="mb-1 block font-medium">{t`Blocked before loading:`}</span>
        {list.map((name) => (
          <span key={name} className="block text-neutral-600 dark:text-neutral-300">
            {name}
          </span>
        ))}
      </div>
    </PickerPopover>
  );
}

function PlainBody({
  text,
  previous,
  background,
  zoom,
  findQuery,
  findIndex,
  onMatches,
}: {
  text: string;
  previous: QuoteHistory;
  background: MessageBackground;
  zoom: ReaderZoom;
  findQuery: string;
  findIndex: number;
  onMatches: ((count: number) => void) | undefined;
}) {
  const { t } = useLingui();
  const [showQuotes, setShowQuotes] = useState(false);
  const parts = useMemo(() => splitRepeatedQuote(text, previous), [text, previous]);
  const root = useRef<HTMLPreElement>(null);
  const visible = parts.body + (showQuotes || findQuery ? parts.quote : "");
  const { termsKey, present: presentHits } = useSearchHits();
  useEffect(() => {
    if (!root.current) return constVoid;
    root.current.textContent = visible;
    markPlainSearchHits(root.current, searchTermsOf(termsKey));
    presentHits(root.current);
    const highlights = highlightBody(root.current, findQuery);
    onMatches?.(highlights.count);
    highlights.select(highlights.count ? findIndex % highlights.count : 0);
    return () => highlights.dispose();
  }, [visible, findQuery, findIndex, onMatches, termsKey, presentHits]);
  return (
    <>
      <pre
        ref={root}
        dir="auto"
        className={`rounded-lg p-4 font-sans leading-relaxed whitespace-pre-wrap ${background === "dark" ? "bg-black text-neutral-100" : "bg-white text-neutral-900"}`}
        style={{ fontSize: (14 * zoom) / 100 }}
      />
      {parts.quote && (
        <button
          type="button"
          className="px-4 text-a11y-accent"
          onClick={() => setShowQuotes(!showQuotes)}
        >
          {showQuotes ? t`Hide quoted text` : t`Show quoted text`}
        </button>
      )}
    </>
  );
}

/** "Remote images blocked" and the tracker badge, above the body. */
function RemoteImagesNotice({
  imageNotice,
  trackers,
  onLoadImages,
  onAlwaysLoad,
}: {
  imageNotice: boolean;
  /** The tracker badge, or null when there are none. */
  trackers: ReactNode;
  onLoadImages: () => void;
  /** Offered for authenticated senders only. */
  onAlwaysLoad: (() => void) | undefined;
}) {
  const { t } = useLingui();
  if (!imageNotice && !trackers) return null;
  const tradeOff = t`Loading remote images lets the sender see when you open a message and your IP address.`;
  return (
    <div
      data-images-notice={imageNotice || undefined}
      className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] ${imageNotice ? "rounded-md bg-neutral-100 px-3 py-1.5 text-neutral-600 dark:bg-white/5 dark:text-neutral-400" : ""}`}
    >
      {imageNotice && (
        <>
          <span className="flex items-center gap-1.5">
            <ImageOff className="size-3.5 shrink-0" />
            <Trans>Remote images blocked</Trans>
          </span>
          <button
            type="button"
            onClick={onLoadImages}
            title={tradeOff}
            className="font-medium whitespace-nowrap text-a11y-accent hover:underline dark:text-blue-400"
          >
            <Trans>Load images</Trans>
          </button>
          {onAlwaysLoad && (
            <button
              type="button"
              onClick={onAlwaysLoad}
              className="font-medium whitespace-nowrap text-a11y-accent hover:underline dark:text-blue-400"
            >
              <Trans>Always from this sender</Trans>
            </button>
          )}
        </>
      )}
      {trackers && <span className={imageNotice ? "ml-auto flex" : "flex"}>{trackers}</span>}
    </div>
  );
}
