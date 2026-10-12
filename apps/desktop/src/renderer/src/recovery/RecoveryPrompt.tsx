import { AlertTriangle, CircleX, Info } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import type { RecoveryPrompt as Prompt } from "../../../shared/recovery";
import { buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui/styles";

const icons = {
  warning: { Icon: AlertTriangle, tint: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  info: { Icon: Info, tint: "bg-blue-500/15 text-a11y-accent" },
  error: { Icon: CircleX, tint: "bg-red-500/15 text-a11y-danger" },
} as const;

/** The whole recovery window: one question and its buttons. Escape picks the cancel button. */
export function RecoveryPrompt({
  prompt,
  onAnswer,
}: {
  prompt: Prompt;
  onAnswer: (index: number) => void;
}) {
  const title = useId();
  const detail = useId();
  const initial = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    initial.current?.focus();
  }, []);
  // Escape answers Cancel, like the native box it replaces.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onAnswer(prompt.cancelId);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onAnswer, prompt.cancelId]);
  const { Icon, tint } = icons[prompt.tone];
  return (
    <div
      role="alertdialog"
      aria-labelledby={title}
      aria-describedby={detail}
      data-full-window
      className="flex h-full flex-col gap-4 bg-white p-6 text-[13px] text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <div className="flex min-h-0 flex-1 gap-4">
        <span
          aria-hidden
          className={`flex size-10 shrink-0 items-center justify-center rounded-full ${tint}`}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5 overflow-y-auto">
          <h1 id={title} className="text-[15px] leading-snug font-semibold">
            {prompt.message}
          </h1>
          <p
            id={detail}
            className="selectable leading-relaxed break-words whitespace-pre-line text-a11y-muted"
          >
            {prompt.detail}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {prompt.buttons.map((label, index) => (
          <button
            key={index}
            type="button"
            ref={index === prompt.defaultId ? initial : undefined}
            onClick={() => onAnswer(index)}
            className={
              index === prompt.destructiveId
                ? buttonDanger
                : index === prompt.defaultId
                  ? buttonPrimary
                  : buttonSecondary
            }
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
