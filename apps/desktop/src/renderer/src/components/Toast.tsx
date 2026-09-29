import { useEffect } from "react";

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

  if (!toast) return null;
  return (
    <output
      className={`fixed bottom-5 left-1/2 z-40 flex max-w-[560px] -translate-x-1/2 items-center gap-4 rounded-lg px-4 py-2.5 text-[13px] shadow-xl ${
        toast.tone === "error"
          ? "bg-red-600 text-white"
          : "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      }`}
    >
      <span className="min-w-0 truncate">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onDone();
          }}
          className="shrink-0 font-semibold text-blue-300 hover:text-blue-200 dark:text-blue-600"
        >
          {toast.action.label}
        </button>
      )}
    </output>
  );
}
