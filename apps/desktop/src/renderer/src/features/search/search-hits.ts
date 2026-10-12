import { plainSearchHits, SEARCH_HIT_CLASS } from "@openmail/core/schema";
import { createContext, useCallback, useContext, useRef } from "react";

/**
 * The open search's words for one message body. Core marks them in the
 * sanitized HTML; the reader styles the marks, counts them and moves between
 * them. `index` is -1 for a message that is not the active one.
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
 * colors and counts the marks under a root. It scrolls only when the current
 * hit changes, so closing find or toggling quotes leaves the view in place.
 */
export function useSearchHits() {
  const { terms, index, onCount } = useContext(SearchHitsContext);
  const termsKey = terms.join("\u0000");
  const scrolled = useRef<{ root: HTMLElement; key: string } | null>(null);
  const present = useCallback(
    (root: HTMLElement) => {
      if (!termsKey) return;
      const key = `${termsKey}\u0001${index}`;
      const scroll =
        index >= 0 && (scrolled.current?.root !== root || scrolled.current.key !== key);
      if (scroll) scrolled.current = { root, key };
      // Marks are colored even on a message that does not report a count.
      const count = presentSearchHits(root, index, scroll);
      onCount?.(count);
    },
    [termsKey, index, onCount],
  );
  return { termsKey, present };
}

export const searchTermsOf = (termsKey: string) => (termsKey ? termsKey.split("\u0000") : []);

const HIT = "#fef08a";
const ACTIVE = "#fb923c";

/** Wraps hits in a plain-text body. Text goes in through textContent only. */
export function markPlainSearchHits(root: HTMLElement, terms: readonly string[]) {
  const text = root.textContent;
  const ranges = plainSearchHits(text, terms);
  if (!ranges.length) return;
  const document = root.ownerDocument;
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const { start, end } of ranges) {
    fragment.append(document.createTextNode(text.slice(position, start)));
    const mark = document.createElement("mark");
    mark.className = SEARCH_HIT_CLASS;
    mark.textContent = text.slice(start, end);
    fragment.append(mark);
    position = end;
  }
  fragment.append(document.createTextNode(text.slice(position)));
  root.replaceChildren(fragment);
}

/**
 * Colors the visible marks, the `index`th one as current, and scrolls it into
 * view when asked. Marks inside collapsed quotes are skipped. Returns the visible count.
 */
export function presentSearchHits(root: HTMLElement, index: number, scroll = true): number {
  const marks = [...root.querySelectorAll<HTMLElement>(`mark.${SEARCH_HIT_CLASS}`)].filter(
    (mark) =>
      !mark.closest("[hidden]") &&
      (typeof mark.checkVisibility !== "function" || mark.checkVisibility()),
  );
  const current = marks.length && index >= 0 ? index % marks.length : -1;
  for (const [i, mark] of marks.entries()) {
    mark.style.setProperty("background", i === current ? ACTIVE : HIT, "important");
    mark.style.setProperty("color", "#111", "important");
  }
  const active = marks[current];
  if (scroll && typeof active?.scrollIntoView === "function")
    active.scrollIntoView({ block: "center" });
  return marks.length;
}
