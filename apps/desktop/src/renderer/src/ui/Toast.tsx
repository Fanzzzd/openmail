import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { touchTarget } from "./styles";

export interface ToastState {
  /** Changes on every new toast so the hide timer restarts. */
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  tone?: "error";
  /** Milliseconds; defaults to 5 s. */
  duration?: number;
}

/**
 * One line at the bottom of the window. A new toast replaces the current one. It stays while
 * the pointer is over it or focus is in it, and Escape or its action returns focus to where
 * it came from.
 */
export function Toast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  const [held, setHeld] = useState({ id: -1, hover: false, focus: false });
  const holding = held.id === toast?.id && (held.hover || held.focus);
  const hold = (change: Partial<Pick<typeof held, "hover" | "focus">>) =>
    setHeld((current) => ({
      ...(current.id === toast?.id ? current : { hover: false, focus: false }),
      ...change,
      id: toast?.id ?? -1,
    }));
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const timer = toast && !holding ? setTimeout(onDone, toast.duration ?? 5000) : undefined;
    return () => clearTimeout(timer);
  }, [toast, onDone, holding]);
  const close = (then?: () => void) => {
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus();
    then?.();
    onDone();
  };

  // Keep both announcement channels mounted before text arrives.
  const announcement = toast ? `${toast.text} ${toast.action?.label ?? ""}`.trim() : "";
  return (
    <>
      <output aria-live="polite" aria-atomic="true" className="sr-only">
        {toast?.tone !== "error" ? announcement : ""}
      </output>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {toast?.tone === "error" ? announcement : ""}
      </div>
      {toast && (
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape only dismisses; the action is a button.
        <div
          key={toast.id}
          onMouseEnter={() => hold({ hover: true })}
          onMouseLeave={() => hold({ hover: false })}
          onFocus={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              returnFocus.current =
                event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
            hold({ focus: true });
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) hold({ focus: false });
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
          }}
          className="fixed bottom-5 left-1/2 z-40 web:bottom-[calc(1.25rem+env(safe-area-inset-bottom))] flex w-max max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 animate-toast-in items-center gap-3 rounded-card bg-neutral-800/95 px-3.5 py-2 text-body text-white shadow-popup backdrop-blur-xl dark:bg-neutral-700/95"
        >
          {toast.tone === "error" && (
            <CircleAlert aria-hidden className="size-4 shrink-0 text-red-400 dark:text-red-300" />
          )}
          <span className="min-w-0 break-words">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => close(toast.action?.run)}
              className={`-my-1 shrink-0 rounded-item px-1.5 py-1 font-semibold text-blue-300 hover:bg-white/10 hover:text-blue-200 ${touchTarget}`}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
