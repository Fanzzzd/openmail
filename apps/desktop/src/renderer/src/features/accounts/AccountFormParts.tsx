import { useId, type ReactNode, type Ref } from "react";

import { formInput } from "../../ui/styles";

// Shared form parts of the add-account steps.

export function Field({
  label,
  value,
  onChange,
  password,
  type,
  autoFocus,
  inputMode,
  placeholder,
  onBlur,
  hint,
  accessibleName,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  password?: boolean;
  type?: "text" | "email";
  autoFocus?: boolean;
  inputMode?: "numeric";
  placeholder?: string | undefined;
  onBlur?: () => void;
  /** One line under the field, read as its description. */
  hint?: string;
  /**
   * A fuller name for screen readers when the visible label repeats, such as "IMAP port" for
   * "Port". It must contain the visible label.
   */
  accessibleName?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const hintId = useId();
  const field = (
    <label className="mt-3 block text-footnote font-medium text-a11y-muted">
      {label}
      <input
        ref={inputRef}
        type={password ? "password" : (type ?? "text")}
        value={value}
        autoFocus={autoFocus}
        inputMode={inputMode}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={`selectable mt-1 h-8 ${formInput}`}
        aria-label={accessibleName}
        aria-describedby={hint ? hintId : undefined}
      />
    </label>
  );
  // The hint sits outside the label, so it describes the field without joining its name.
  return hint ? (
    <>
      {field}
      <p id={hintId} className="mt-1 text-footnote text-a11y-muted">
        {hint}
      </p>
    </>
  ) : (
    field
  );
}

export function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="mt-3 text-footnote text-a11y-danger">
      {text}
    </p>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}

export function SecondaryButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-control bg-white px-4 font-medium text-neutral-900 shadow-control ring-1 ring-edge hover:bg-neutral-50 active:bg-neutral-100 dark:bg-white/[0.08] dark:text-neutral-100 dark:hover:bg-white/[0.12] dark:active:bg-white/[0.16]"
    >
      {children}
    </button>
  );
}

export function PrimaryButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type={onClick ? "button" : "submit"}
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-control bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
