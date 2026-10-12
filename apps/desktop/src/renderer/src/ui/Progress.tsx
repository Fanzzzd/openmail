import { Progress } from "@base-ui/react/progress";

/** A thin bar. `value` null draws an indeterminate bar. */
export function ProgressBar({
  value,
  max = 100,
  "aria-label": label,
  className = "",
}: {
  value: number | null;
  max?: number;
  "aria-label": string;
  className?: string;
}) {
  return (
    <Progress.Root value={value} max={max} aria-label={label} className={`w-full ${className}`}>
      <Progress.Track className="relative h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
        <Progress.Indicator className="block h-full rounded-full bg-blue-600 data-indeterminate:w-1/3 data-indeterminate:opacity-70 data-indeterminate:motion-safe:animate-indeterminate dark:bg-blue-400" />
      </Progress.Track>
    </Progress.Root>
  );
}

/**
 * A ring for a toolbar button. Decorative: the button's label carries the
 * state. A null value spins a quarter arc, unless motion is reduced.
 */
export function ProgressRing({
  value,
  className = "size-4",
}: {
  /** 0–1, or null when the size is not known yet. */
  value: number | null;
  className?: string;
}) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const shown = value === null ? 0.25 : Math.max(0.04, Math.min(1, value));
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`${className} -rotate-90 ${value === null ? "motion-safe:animate-spin" : ""}`}
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        className="stroke-black/12 dark:stroke-white/20"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${circumference * shown} ${circumference}`}
        className="stroke-blue-600 dark:stroke-blue-400"
      />
    </svg>
  );
}
