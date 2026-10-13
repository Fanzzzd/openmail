import { textSearchHits } from "@openmail/core/schema";
import { constVoid } from "effect/Function";
import { createContext, useCallback, useContext, useRef } from "react";
import {
  HIGHLIGHTS,
  paintRanges,
  rangeVisible,
  scrollRangeIntoView,
  textNodes,
} from "./text-highlights";

/**
 * The open search's words for one message body. The reader highlights them,
 * counts them and moves between them. `index` is -1 for a message that is not
 * the active one.
 */
export interface SearchHits {
  terms: readonly string[];
  index: number;
  onCount?: ((count: number) => void) | undefined;
}

export const NO_SEARCH_HITS: SearchHits = { terms: [], index: -1 };
export const SearchHitsContext = createContext<SearchHits>(NO_SEARCH_HITS);

/**
 * The body's search words, joined into one stable key, and `present`, which
 * highlights and counts the hits under a root and returns their cleanup. It
 * scrolls only when the current hit changes, so closing find or toggling
 * quotes leaves the view in place.
 */
export function useSearchHits() {
  const { terms, index, onCount } = useContext(SearchHitsContext);
  const termsKey = terms.join("\u0000");
  const scrolled = useRef<{ root: HTMLElement; key: string } | null>(null);
  const present = useCallback(
    (root: HTMLElement): (() => void) => {
      if (!termsKey) return constVoid;
      const key = `${termsKey}\u0001${index}`;
      const scroll =
        index >= 0 && (scrolled.current?.root !== root || scrolled.current.key !== key);
      if (scroll) scrolled.current = { root, key };
      // Hits are highlighted even on a message that does not report a count.
      const hits = presentSearchHits(root, searchTermsOf(termsKey), index, scroll);
      onCount?.(hits.count);
      return hits.dispose;
    },
    [termsKey, index, onCount],
  );
  return { termsKey, present };
}

const searchTermsOf = (termsKey: string) => (termsKey ? termsKey.split("\u0000") : []);

/**
 * Highlights the visible hits under `root`, the `index`th one as current, and
 * scrolls it into view when asked. Hits inside collapsed quotes are skipped.
 * Nothing is added to the document; `dispose` removes the highlights.
 */
export function presentSearchHits(
  root: HTMLElement,
  terms: readonly string[],
  index: number,
  scroll = true,
): { count: number; dispose: () => void } {
  const doc = root.ownerDocument;
  const nodes = textNodes(root);
  const ranges = textSearchHits(
    nodes.map((node) => node.data),
    terms,
  )
    .flatMap(({ node, start, end }) => {
      const text = nodes[node];
      if (!text) return [];
      const range = doc.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      return [range];
    })
    .filter(rangeVisible);
  const active = ranges.length && index >= 0 ? ranges[index % ranges.length] : undefined;
  const clearHits = paintRanges(
    doc,
    HIGHLIGHTS.searchHit,
    ranges.filter((range) => range !== active),
  );
  const clearActive = paintRanges(doc, HIGHLIGHTS.searchActive, active ? [active] : []);
  if (scroll && active) scrollRangeIntoView(active);
  return {
    count: ranges.length,
    dispose() {
      clearHits();
      clearActive();
    },
  };
}
