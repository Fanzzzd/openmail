import { useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { composeEditorText, type ComposeBody } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { GrammarIssue } from "../../../../../shared/native-compose";
import {
  editorBody,
  editorMatchPoints,
  replaceEditorMatches,
  selectEditorMatch,
  type ComposeElement,
} from "../compose-editor-dom";
import { useRunMail, withMail } from "../../../state/mail";
import { nativeComposeCapabilitiesAtom } from "../../../state/queries";

/**
 * Grammar checking with the Mac's checker: the composer's menu starts a
 * check, and `GrammarResults` lists what it found under the toolbar.
 */
export function useComposeGrammar({
  body,
  bodyRef,
  onChange,
  locked,
}: {
  body: ComposeBody;
  bodyRef: RefObject<ComposeElement | null>;
  onChange: (body: ComposeBody) => void;
  locked: boolean;
}) {
  const run = useRunMail();
  const available = AsyncResult.getOrElse(useAtomValue(nativeComposeCapabilitiesAtom), () => ({
    grammar: false,
  })).grammar;
  const [result, setResult] = useState<{ text: string; issues: readonly GrammarIssue[] } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const serial = useRef(0);
  const text = composeEditorText(body);
  const current = useRef(text);
  useLayoutEffect(() => {
    current.current = text;
  }, [text]);
  const issues = useMemo(() => (result?.text === text ? result.issues : []), [result, text]);
  useEffect(() => {
    const root = bodyRef.current;
    if (
      body.kind !== "rich" ||
      !(root instanceof HTMLDivElement) ||
      typeof Highlight === "undefined"
    )
      return constVoid;
    const ranges: Range[] = [];
    for (const issue of issues) {
      const points = editorMatchPoints(root, issue.start, issue.end);
      if (!points) continue;
      const range = document.createRange();
      range.setStart(points.first.node, points.first.offset);
      range.setEnd(points.last.node, points.last.offset);
      ranges.push(range);
    }
    // Presentation only: no spans enter the draft/MIME or undo stack.
    const highlight = new Highlight(...ranges);
    highlight.type = "grammar-error";
    CSS.highlights.set("openmail-grammar", highlight);
    return () => {
      CSS.highlights.delete("openmail-grammar");
    };
  }, [body, bodyRef, issues]);
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );
  const check = () => {
    if (checking || locked || !text || text.length > 100_000) return;
    const request = ++serial.current;
    setChecking(true);
    setError(false);
    run(
      withMail((call) => call("CheckNativeGrammar", { text })).pipe(
        Effect.matchCause({
          onSuccess: (found) => {
            if (request !== serial.current) return;
            if (current.current === text) setResult({ text, issues: found });
            setChecking(false);
          },
          onFailure: () => {
            if (request !== serial.current) return;
            setChecking(false);
            setError(true);
          },
        }),
      ),
    );
  };
  const replace = (issue: GrammarIssue, suggestion: string) => {
    const root = bodyRef.current;
    if (!root || locked || result?.text !== current.current) return;
    replaceEditorMatches(root, [{ start: issue.start, end: issue.end }], suggestion);
    onChange(editorBody(root, body));
    setResult(null);
  };
  return {
    available,
    checking,
    disabled: checking || locked || !text || text.length > 100_000,
    check,
    text,
    result,
    error,
    issues,
    /** Selects the issue's text in the editor. */
    select: (issue: GrammarIssue) => {
      if (bodyRef.current) selectEditorMatch(bodyRef.current, issue.start, issue.end);
    },
    replace,
    clear: () => setResult(null),
  };
}
type ComposeGrammar = ReturnType<typeof useComposeGrammar>;

export function GrammarResults({ grammar, locked }: { grammar: ComposeGrammar; locked: boolean }) {
  const { t } = useLingui();
  const { text, result, error, issues, select, replace } = grammar;
  if (!grammar.available || (!error && result?.text !== text)) return null;
  return (
    <div className="shrink-0 border-b px-4 py-2 text-footnote border-separator">
      {result?.text === text && (
        <button
          type="button"
          onClick={grammar.clear}
          className="rounded px-2 py-1"
        >{t`Close`}</button>
      )}
      {error && <p role="alert">{t`Could not check grammar on this Mac.`}</p>}
      {result?.text === text && (
        <output className="block max-h-40 overflow-auto">
          {issues.length === 0 ? (
            <span className="block">{t`No grammar suggestions`}</span>
          ) : (
            issues.map((issue) => (
              <span
                key={JSON.stringify([issue.start, issue.end, issue.description])}
                className="block py-1"
              >
                <button type="button" onClick={() => select(issue)}>
                  <span className="underline decoration-wavy decoration-blue-500">
                    {text.slice(issue.start, issue.end)}
                  </span>
                </button>{" "}
                {issue.description}
                {[...new Set(issue.suggestions)].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={locked}
                    onClick={() => replace(issue, suggestion)}
                    className="ml-2 rounded border px-2 py-1 border-separator"
                  >
                    {suggestion}
                  </button>
                ))}
              </span>
            ))
          )}
        </output>
      )}
    </div>
  );
}
