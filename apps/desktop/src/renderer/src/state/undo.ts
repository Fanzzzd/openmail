import { constVoid } from "effect/Function";
import { Effect, type Cause } from "effect";
import { useRef, useEffect, useCallback, useState } from "react";
import type { BatchResult, UndoHistoryEntry } from "@openmail/core/schema";
import type { AppError } from "../errors";
import type { ToastState } from "../components/Toast";
import { undoBatch, useRunMail, withMail } from "./mail";

/** New operations alone bind Cmd+Z. Restored entries require an explicit history action. */
export function useBatchUndo({
  notify,
  clearToast,
  label,
  failureText,
}: {
  notify: (toast: Omit<ToastState, "id">) => void;
  clearToast: () => void;
  label: string;
  failureText: (cause: Cause.Cause<AppError>) => string;
}) {
  const run = useRunMail();
  const undoRef = useRef<(() => void) | null>(null);
  const initialRun = useRef(run);
  const fetched = useRef(false);
  const [history, setHistory] = useState<readonly UndoHistoryEntry[]>([]);
  const activeBatch = useRef<{ id: string; run: () => void } | null>(null);
  const showUndo = useCallback(
    (result: BatchResult, ids: readonly string[], text: string, restored?: () => void) => {
      if (!result.undoId) {
        notify({ text });
        return;
      }
      let used = false;
      const undo = () => {
        if (used) return;
        used = true;
        run(
          undoBatch(result.undoId, ids).pipe(
            Effect.matchCause({
              onFailure: (cause) => {
                used = false;
                notify({ text: failureText(cause), tone: "error", action: { label, run: undo } });
              },
              onSuccess: () => {
                restored?.();
                setHistory((entries) => entries.filter((entry) => entry.undoId !== result.undoId));
                if (undoRef.current === undo) {
                  undoRef.current = null;
                  clearToast();
                }
              },
            }),
          ),
        );
      };
      activeBatch.current = { id: result.undoId, run: undo };
      undoRef.current = undo;
      setHistory((entries) =>
        [
          { undoId: result.undoId, createdAt: Date.now() },
          ...entries.filter((entry) => entry.undoId !== result.undoId),
        ].slice(0, 50),
      );
      notify({ text, action: { label, run: undo } });
    },
    [notify, clearToast, label, failureText, run],
  );
  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    initialRun.current(
      withMail((call) => call("UndoHistory", undefined)).pipe(
        Effect.matchCause({ onFailure: constVoid, onSuccess: setHistory }),
      ),
    );
  }, []);
  const undoRestored = (undoId: string) =>
    run(
      undoBatch(undoId, []).pipe(
        Effect.matchCause({
          onFailure: (cause) => notify({ text: failureText(cause), tone: "error" }),
          onSuccess: () => {
            setHistory((entries) => entries.filter((entry) => entry.undoId !== undoId));
            if (activeBatch.current?.id === undoId && undoRef.current === activeBatch.current.run) {
              undoRef.current = null;
              clearToast();
            }
          },
        }),
      ),
    );
  return { undoRef, showUndo, history, undoRestored };
}
