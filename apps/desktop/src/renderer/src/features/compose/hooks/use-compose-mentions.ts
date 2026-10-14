import { useAtomValue } from "@effect/atom-react";
import { mentionHtml, mentionQuery, type Address } from "@openmail/core/schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { suggestionsAtom } from "../../../state/queries";
import { activeComposeMentions } from "../compose-contacts-dom";

const noSuggestions = Atom.make(AsyncResult.success<readonly Address[]>([]));

interface Options {
  from: string | undefined;
  richRef: RefObject<HTMLDivElement | null>;
  selectionRef: RefObject<Range | null>;
  locked: boolean;
  onMentionsChange: (addresses: readonly string[]) => void;
  /** Inserts the mention's HTML at the selection; true when the editor took it. */
  insert: (html: string) => boolean;
  onMention: (person: Address) => void;
}

/** @-mentions in the rich body: the query at the caret, its suggestions and the people mentioned. */
export function useComposeMentions({
  from,
  richRef,
  selectionRef,
  locked,
  onMentionsChange,
  insert,
  onMention,
}: Options) {
  const [mention, setMention] = useState<{ query: string; range: Range } | null>(null);
  const [index, setIndex] = useState(0);
  const mentioned = useRef(new Map<string, Address>());
  const suggestions = AsyncResult.getOrElse(
    useAtomValue(mention ? suggestionsAtom(mention.query, from) : noSuggestions),
    () => [],
  );

  /** Reports the addresses still mentioned in the body. */
  const refresh = () => onMentionsChange(activeComposeMentions(richRef.current, mentioned.current));
  /** Opens, moves or closes the suggestions for the @-token before the caret. */
  const updateQuery = () => {
    const range = selectionRef.current;
    if (!range?.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) {
      setMention(null);
      return;
    }
    const text = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
    const token = mentionQuery(text);
    if (!token || range.startContainer.parentElement?.closest("a,pre,code")) {
      setMention(null);
      return;
    }
    const selected = range.cloneRange();
    selected.setStart(range.startContainer, range.startOffset - token.length);
    setMention({ query: token.query, range: selected });
    setIndex(0);
  };
  const pick = (person: Address) => {
    if (!mention || locked || !richRef.current?.contains(mention.range.commonAncestorContainer))
      return;
    const id = crypto.randomUUID();
    mentioned.current.set(id, person);
    selectionRef.current = mention.range;
    if (insert(mentionHtml(person, id))) onMention(person);
    setMention(null);
  };
  /** Arrow keys, Enter, Tab and Escape while suggestions show. True when handled. */
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!mention || !suggestions.length || event.metaKey || event.ctrlKey || event.altKey)
      return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(
        (current) =>
          (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) %
          suggestions.length,
      );
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const person = suggestions[index];
      if (person) pick(person);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMention(null);
      return true;
    }
    return false;
  };

  return {
    /** Empty while no @-token is at the caret. */
    suggestions,
    index,
    pick,
    close: () => setMention(null),
    refresh,
    updateQuery,
    handleKey,
  };
}
