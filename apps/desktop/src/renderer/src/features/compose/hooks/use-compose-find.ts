import { composeEditorText, composeMatches, type ComposeBody } from "@openmail/core/schema";
import { useState, type KeyboardEvent, type RefObject } from "react";
import { matchesShortcut, type ShortcutSet } from "../../../../../shared/shortcuts";
import { jumpDocumentSelection, jumpTextareaSelection } from "../../../lib/jump-selection";
import {
  editorBody,
  replaceEditorMatches,
  selectEditorMatch,
  type ComposeElement,
} from "../compose-editor-dom";

interface Options {
  body: ComposeBody;
  bodyRef: RefObject<ComposeElement | null>;
  shortcutSet: ShortcutSet;
  locked: boolean;
  onChange: (body: ComposeBody) => void;
  /** Stores the live selection after a match is selected. */
  remember: () => void;
  /** Emits the rich body after a replacement edited it in place. */
  changed: () => void;
}

/** Find and replace in the message text, and the Find menu keys that drive it. */
export function useComposeFind({
  body,
  bodyRef,
  shortcutSet,
  locked,
  onChange,
  remember,
  changed,
}: Options) {
  const [finding, setFinding] = useState(false);
  const [query, setQueryState] = useState("");
  const [replacement, setReplacement] = useState("");
  const [index, setIndex] = useState(0);
  const matches = composeMatches(composeEditorText(body), query);

  const setQuery = (next: string) => {
    setQueryState(next);
    setIndex(0);
  };
  const select = (next: number) => {
    const match = matches[next];
    if (match && bodyRef.current) selectEditorMatch(bodyRef.current, match.start, match.end);
    setIndex(next);
    remember();
  };
  const replace = (all: boolean) => {
    const element = bodyRef.current;
    if (!element || locked) return;
    const targets = all
      ? matches.toReversed()
      : matches.slice(
          index % Math.max(1, matches.length),
          (index % Math.max(1, matches.length)) + 1,
        );
    if (!replaceEditorMatches(element, targets, replacement)) return;
    if (element instanceof HTMLTextAreaElement) onChange(editorBody(element, body));
    else changed();
    setIndex(0);
  };
  /** Enter and Escape in the find bar, after the editor keys had their turn. */
  const barKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (matches.length)
        select((index + (event.shiftKey ? matches.length - 1 : 1)) % matches.length);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setFinding(false);
    }
  };
  /** Find, Jump to Selection, Use Selection for Find and Find Next/Previous. True when handled. */
  const handleKey = (event: KeyboardEvent<HTMLElement>, inBody: boolean) => {
    if (
      matchesShortcut(shortcutSet, "search", event) &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      setFinding(true);
      return true;
    }
    if (matchesShortcut(shortcutSet, "jumpSelection", event) && inBody) {
      event.preventDefault();
      event.stopPropagation();
      const element = bodyRef.current;
      if (element instanceof HTMLTextAreaElement) {
        jumpTextareaSelection(element);
      } else jumpDocumentSelection(document);
      return true;
    }
    if (matchesShortcut(shortcutSet, "findSelection", event) && inBody) {
      event.preventDefault();
      event.stopPropagation();
      const element = bodyRef.current;
      const text =
        element instanceof HTMLTextAreaElement
          ? element.value.slice(element.selectionStart, element.selectionEnd)
          : (window.getSelection()?.toString() ?? "");
      if (text) {
        setQueryState(text);
        setIndex(0);
        setFinding(true);
      }
      return true;
    }
    if (
      matchesShortcut(shortcutSet, "findNext", event) ||
      matchesShortcut(shortcutSet, "findPrevious", event)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!finding) setFinding(true);
      if (matches.length)
        select(
          (index + (matchesShortcut(shortcutSet, "findPrevious", event) ? matches.length - 1 : 1)) %
            matches.length,
        );
      return true;
    }
    return false;
  };

  return {
    finding,
    toggle: () => setFinding((value) => !value),
    close: () => setFinding(false),
    query,
    setQuery,
    replacement,
    setReplacement,
    index,
    count: matches.length,
    select,
    replace,
    barKey,
    handleKey,
  };
}
