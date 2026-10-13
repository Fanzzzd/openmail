import { useLingui } from "@lingui/react/macro";
import { customTemplateVariables, type Template } from "@openmail/core/schema";
import type { Dispatch, SetStateAction } from "react";
import { alertButton, alertPrimary } from "../../../ui/Dialog";

/** Fields for a template's own variables, filled before the template goes into the message. */
export function TemplateVariables({
  template,
  values,
  setValues,
  onInsert,
  onCancel,
}: {
  template: Template;
  values: Readonly<Record<string, string>>;
  setValues: Dispatch<SetStateAction<Record<string, string>>>;
  onInsert: (template: Template, values: Readonly<Record<string, string>>) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  return (
    <fieldset className="shrink-0 space-y-2 border-b border-separator px-4 py-3">
      <legend>{t`Fill template variables`}</legend>
      {customTemplateVariables(template.subject, template.body).map((name) => (
        <label key={name} className="flex items-center gap-2">
          <span>{name}</span>
          <input
            aria-label={name}
            value={values[name] ?? ""}
            className="min-w-0 flex-1 rounded border px-2 py-1 border-separator"
            onChange={(event) =>
              setValues((previous) => ({
                ...previous,
                [name]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                onInsert(template, values);
              }
            }}
          />
        </label>
      ))}
      <button
        type="button"
        className={alertPrimary}
        onClick={() => onInsert(template, values)}
      >{t`Insert template`}</button>
      <button type="button" className={alertButton} onClick={onCancel}>{t`Cancel`}</button>
    </fieldset>
  );
}
