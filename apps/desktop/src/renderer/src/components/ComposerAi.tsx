import { useAtomValue } from "@effect/atom-react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  AI_REWRITE_TONES,
  composeAiDiff,
  composeAiReplacement,
  type AiComposeRequest,
  type ComposeBody,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  editorBody,
  editorCaretOffset,
  replaceEditorText,
  type ComposeElement,
} from "../compose-editor-dom";
import { withMail } from "../state/mail";
import { AiOutput, useAiStream } from "./AiPanel";
import { aiSettingsAtom } from "./AiSettings";
import { Dialog } from "./ui/Dialog";

const tones = {
  shorter: msg`Shorter`,
  friendlier: msg`Friendlier`,
  formal: msg`More formal`,
  proofread: msg`Fix grammar and proofread`,
};
type Snapshot = {
  body: ComposeBody;
  start: number;
  end: number;
  accountId: string;
  replyTo?: string;
};

export function ComposerAi({
  accountId,
  replyTo,
  body,
  bodyRef,
  selectionRef,
  onChange,
}: {
  accountId: string;
  replyTo?: string;
  body: ComposeBody;
  bodyRef: RefObject<ComposeElement | null>;
  selectionRef: RefObject<Range | null>;
  onChange: (body: ComposeBody) => void;
}) {
  const { t, i18n } = useLingui();
  const settings = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null);
  const allowed = settings?.accounts.some((a) => a.accountId === accountId && a.allowed);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [undo, setUndo] = useState<{ before: ComposeBody; accepted: ComposeBody } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [language, setLanguage] = useState("");
  const [mode, setMode] = useState<"write" | "rewrite" | "translate">("write");
  const [tone, setTone] = useState<(typeof AI_REWRITE_TONES)[number]>("shorter");
  const result = useAiStream();
  const { cancel } = result;
  const open = useCallback(() => {
    if (!allowed) return;
    const element = bodyRef.current;
    const current = element ? editorBody(element, body) : body;
    let start = 0;
    let end = current.text.length;
    if (element instanceof HTMLTextAreaElement && element.selectionStart !== element.selectionEnd) {
      start = element.selectionStart;
      end = element.selectionEnd;
    } else if (element && !(element instanceof HTMLTextAreaElement)) {
      const live = window.getSelection();
      const range =
        live?.rangeCount && element.contains(live.getRangeAt(0).commonAncestorContainer)
          ? live.getRangeAt(0)
          : selectionRef.current;
      if (range && !range.collapsed && element.contains(range.commonAncestorContainer)) {
        start = editorCaretOffset(element, range);
        end = editorCaretOffset(element, range, "end");
      }
    }
    cancel();
    setSnapshot({ body: current, start, end, accountId, ...(replyTo ? { replyTo } : {}) });
  }, [allowed, accountId, replyTo, body, bodyRef, selectionRef, cancel]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        event.stopImmediatePropagation();
        open();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);
  useEffect(() => {
    if (
      !allowed ||
      (snapshot && (snapshot.accountId !== accountId || snapshot.replyTo !== replyTo))
    ) {
      cancel();
    }
  }, [allowed, accountId, replyTo, snapshot, cancel]);
  if (snapshot && (!allowed || snapshot.accountId !== accountId || snapshot.replyTo !== replyTo))
    setSnapshot(null);
  if (undo && JSON.stringify(body) !== JSON.stringify(undo.accepted)) setUndo(null);
  const close = () => {
    cancel();
    setSnapshot(null);
  };
  const after = snapshot
    ? composeAiReplacement(snapshot.body.text, snapshot.start, snapshot.end, result.text)
    : "";
  const diff = composeAiDiff(snapshot?.body.text ?? "", after);
  return (
    <>
      <div className="flex shrink-0 gap-3 px-4 py-1 text-xs text-violet-600 dark:text-violet-300">
        <button
          type="button"
          disabled={!allowed || !settings?.keyConfigured}
          onClick={() => open()}
        >
          <Trans>Write with AI</Trans> ·{" "}
          {navigator.platform.startsWith("Mac") ? "⇧⌘J" : "Ctrl+Shift+J"}
        </button>
        {undo && (
          <button
            type="button"
            onClick={() => {
              const element = bodyRef.current;
              const current = element ? editorBody(element, body) : body;
              if (JSON.stringify(current) === JSON.stringify(undo.accepted)) onChange(undo.before);
              setUndo(null);
            }}
          >
            <Trans>Undo AI edit</Trans>
          </button>
        )}
      </div>
      {snapshot && (
        <Dialog
          aria-label={t`Write with AI`}
          onClose={close}
          className="max-h-[85vh] w-[600px] space-y-3 overflow-y-auto p-5"
        >
          <h2 className="font-semibold">
            <Trans>Write with AI</Trans>
          </h2>
          <select
            aria-label={t`AI action`}
            value={mode}
            disabled={result.status === "running"}
            onChange={(e) => {
              if (
                e.target.value === "write" ||
                e.target.value === "rewrite" ||
                e.target.value === "translate"
              )
                setMode(e.target.value);
            }}
          >
            <option value="write">{t`Write with AI`}</option>
            <option value="rewrite">{t`Rewrite`}</option>
            <option value="translate">{t`Translate`}</option>
          </select>
          {mode === "write" && (
            <textarea
              className="block w-full rounded border bg-transparent p-2"
              aria-label={t`Writing instruction`}
              maxLength={4000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          )}
          {mode === "rewrite" && (
            <select
              aria-label={t`Tone`}
              value={tone}
              onChange={(e) => {
                const next = AI_REWRITE_TONES.find((value) => value === e.target.value);
                if (next) setTone(next);
              }}
            >
              {AI_REWRITE_TONES.map((value) => (
                <option key={value} value={value}>
                  {i18n._(tones[value])}
                </option>
              ))}
            </select>
          )}
          {mode === "translate" && (
            <input
              className="rounded border bg-transparent p-2"
              aria-label={t`Target language`}
              maxLength={100}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            />
          )}
          <button
            type="button"
            disabled={
              result.status === "running" ||
              (mode === "write" && !instruction.trim()) ||
              (mode === "translate" && !language.trim())
            }
            onClick={() => {
              const task: AiComposeRequest["task"] =
                mode === "write"
                  ? { kind: "write", instruction: instruction.trim() }
                  : mode === "translate"
                    ? { kind: "translate", language: language.trim() }
                    : { kind: "rewrite", tone };
              result.start(
                withMail((call) =>
                  Effect.succeed(
                    call("ComposeAi", {
                      input: {
                        accountId: snapshot.accountId,
                        replyTo: snapshot.replyTo,
                        text: snapshot.body.text.slice(snapshot.start, snapshot.end),
                        task,
                      },
                    }),
                  ),
                ),
              );
            }}
          >
            <Trans>Generate preview</Trans>
          </button>
          <AiOutput result={result} openSource={constVoid} />
          {result.status === "done" && (
            <>
              <p className="whitespace-pre-wrap break-words" aria-label={t`Preview changes`}>
                {diff.prefix}
                <del className="bg-red-500/15">{diff.removed}</del>
                <ins className="bg-green-500/15">{diff.added}</ins>
                {diff.suffix}
              </p>
              <button
                type="button"
                disabled={!allowed || result.truncated || !result.text}
                onClick={() => {
                  const element = bodyRef.current;
                  if (!element) return;
                  const current = editorBody(element, body);
                  if (JSON.stringify(current) !== JSON.stringify(snapshot.body)) {
                    close();
                    return;
                  }
                  // replaceEditorText escapes text and runs it through the existing compose sanitizer.
                  replaceEditorText(element, current.text, after);
                  const accepted = editorBody(element, current);
                  setUndo({ before: current, accepted });
                  onChange(accepted);
                  close();
                }}
              >
                <Trans>Accept</Trans>
              </button>
            </>
          )}
          <button type="button" onClick={close}>
            <Trans>Discard</Trans>
          </button>
        </Dialog>
      )}
    </>
  );
}
