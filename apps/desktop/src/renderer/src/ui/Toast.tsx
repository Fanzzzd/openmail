import { CircleAlert } from "lucide-react";
import { useEffect } from "react";
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

/** One line at the bottom of the window. A new toast replaces the current one. */
export function Toast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  useEffect(() => {
    const timer = toast ? setTimeout(onDone, toast.duration ?? 5000) : undefined;
    return () => clearTimeout(timer);
  }, [toast, onDone]);

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
        <div
          key={toast.id}
          className="fixed bottom-5 left-1/2 z-40 web:bottom-[calc(1.25rem+env(safe-area-inset-bottom))] flex w-max max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 animate-toast-in items-center gap-3 rounded-card bg-neutral-800/95 px-3.5 py-2 text-body text-white shadow-popup backdrop-blur-xl dark:bg-neutral-700/95"
        >
          {toast.tone === "error" && (
            <CircleAlert aria-hidden className="size-4 shrink-0 text-red-400 dark:text-red-300" />
          )}
          <span className="min-w-0 break-words">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                onDone();
              }}
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
