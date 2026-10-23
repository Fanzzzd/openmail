/**
 * A color well, like NSColorWell: a small bezel with the color inside. A click opens the system
 * color panel.
 */
export function ColorWell({
  value,
  onValueChange,
  "aria-label": ariaLabel,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  "aria-label": string;
  disabled?: boolean;
}) {
  return (
    <input
      type="color"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
      className="h-5 w-8 shrink-0 cursor-default appearance-none rounded-[5px] bg-white p-[3px] shadow-control ring-1 ring-edge outline-offset-1 outline-a11y-focus focus-visible:outline-2 disabled:opacity-50 dark:bg-white/[0.08] [&::-webkit-color-swatch]:rounded-[2px] [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
    />
  );
}
