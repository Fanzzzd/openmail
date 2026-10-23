import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";

import { Switch } from "./Switch";
import { settingsGroup, settingsHeading, settingsHint } from "./styles";

/**
 * A titled box of setting rows, like a group in macOS System Settings. A
 * footer explains the whole group under the box.
 */
export function SettingsGroup({
  title,
  footer,
  className = "",
  children,
}: {
  title?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      {title && <h3 className={settingsHeading}>{title}</h3>}
      <div className={settingsGroup}>{children}</div>
      {footer && <div className={`mt-1.5 px-1 ${settingsHint}`}>{footer}</div>}
    </section>
  );
}

/**
 * One setting: the label on the left, the control on the right and a hint
 * under the label. In a narrow pane the control moves under the label.
 * `htmlFor` makes the label a real <label> for the control's id.
 */
export function SettingsRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-6 gap-y-1.5 px-3 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <Label htmlFor={htmlFor} className="block">
          {label}
        </Label>
        {hint && <div className={`mt-0.5 ${settingsHint}`}>{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * An on/off setting, as in System Settings: the label on the left, a switch on the right and a
 * hint under the label. The label is a Base UI Field label, so a click on it toggles the switch,
 * and the hint becomes the switch's description.
 */
export function SettingsSwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** More content under the hint, such as a status line or a link. */
  children?: ReactNode;
}) {
  return (
    <Field.Root
      disabled={disabled}
      className="flex min-h-10 items-center gap-x-6 px-3 py-2 data-disabled:text-a11y-muted"
    >
      <div className="min-w-0 flex-1">
        <Field.Label className="block">{label}</Field.Label>
        {hint && <Field.Description className={`mt-0.5 ${settingsHint}`}>{hint}</Field.Description>}
        {children}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </Field.Root>
  );
}

/** A checkbox row: the box and its label on one line, the hint under the label. */
export function SettingsCheckRow({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="px-3 py-2">
      {children}
      {hint && <div className={`mt-0.5 pl-[22px] ${settingsHint}`}>{hint}</div>}
    </div>
  );
}
