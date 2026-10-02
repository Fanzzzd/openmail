import { Effect, type Cause } from "effect";
import { useRef } from "react";
import type { BatchResult } from "@openmail/core/schema";
import type { AppError } from "../errors";
import type { ToastState } from "../components/Toast";
import { undoBatch, useRunMail } from "./mail";

/** Thread and reader actions share the toast button and the window's Undo command. */
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
  const showUndo = (
    result: BatchResult,
    ids: readonly string[],
    text: string,
    restored?: () => void,
  ) => {
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
              if (undoRef.current === undo) {
                undoRef.current = null;
                clearToast();
              }
            },
          }),
        ),
      );
    };
    undoRef.current = undo;
    notify({ text, action: { label, run: undo } });
  };
  return { undoRef, showUndo };
}
