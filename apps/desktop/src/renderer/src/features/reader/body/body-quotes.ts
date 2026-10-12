import type { QuoteHistory } from "@openmail/core/schema";
import { startTransition, useEffect, useState } from "react";
import { repeatedQuoteElements } from "./body-text";

/**
 * Search navigation and quote toggles reuse the document's detected quote list.
 * A new history (the thread reloads when a message is marked read) keeps the
 * previous list until the new one is ready, so folded quotes do not flash open.
 */
export function useBodyQuotes(document: Document | null, history: QuoteHistory) {
  const [state, setState] = useState<{
    document: Document;
    history: QuoteHistory;
    elements: HTMLElement[];
  } | null>(null);
  useEffect(() => {
    if (document) {
      const elements = repeatedQuoteElements(document.body, history);
      startTransition(() => setState({ document, history, elements }));
    }
  }, [document, history]);
  return state?.document === document ? state.elements : undefined;
}
