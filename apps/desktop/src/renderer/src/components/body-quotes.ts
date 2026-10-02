import type { QuoteHistory } from "@openmail/core/schema";
import { startTransition, useEffect, useState } from "react";
import { repeatedQuoteElements } from "./body-text";

/** Search navigation and quote toggles reuse the document's detected quote list. */
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
  return state?.document === document && state.history === history ? state.elements : undefined;
}
