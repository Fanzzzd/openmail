import { Exit } from "effect";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { TEMPLATE_VARIABLES } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import type { Template } from "../../../../../shared/api";
import { formatAddress, parseAddresses } from "../../compose/draft";
import { causeText } from "../../../lib/errors";
import { Keys } from "../../../state/keys";
import { deleteTemplateAtom, saveTemplateAtom } from "../../../state/mutations";
import { templatesAtom } from "../../../state/queries";
import { Select } from "../../../ui/Select";
import { SettingsGroup } from "../../../ui/SettingsRows";
import {
  buttonLink,
  buttonPrimary,
  buttonSecondary,
  formInput,
  settingsHint,
} from "../../../ui/styles";

const VARIABLE_LABELS = {
  first_name: msg`Recipient first name`,
  last_name: msg`Recipient last name`,
  name: msg`Recipient name`,
  email: msg`Recipient email`,
  recipient_first_name: msg`Recipient first name`,
  recipient_last_name: msg`Recipient last name`,
  recipient_name: msg`Recipient name`,
  recipient_email: msg`Recipient email`,
  sender_first_name: msg`Sender first name`,
  sender_last_name: msg`Sender last name`,
  sender_name: msg`Sender name`,
  sender_email: msg`Sender email`,
  date: msg`Date`,
  time: msg`Time`,
  day: msg`Day`,
  month: msg`Month`,
  year: msg`Year`,
  subject: msg`Subject`,
  to: msg`To`,
  cc: msg`Cc`,
  bcc: msg`Bcc`,
};
/** A text action in a template row. Callers add the color. */
const rowAction =
  "shrink-0 rounded-item font-medium outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2";
/** The box the editor sits in, below the template list. */
const editorCard = "rounded-card bg-raised px-4 pt-3 pb-4 ring-1 ring-edge dark:bg-white/[0.03]";
/** The editor's title: a legend floated into the box so the padding stays even. */
const editorLegend = "float-left mb-3 w-full p-0 text-callout font-semibold";
/** A field's label, above the field. */
const fieldLabel = "mb-1 block text-footnote font-medium text-a11y-muted";
type Form = {
  id: string | null;
  name: string;
  subject: string;
  to: string;
  cc: string;
  bcc: string;
  body: string;
};
const blank: Form = { id: null, name: "", subject: "", to: "", cc: "", bcc: "", body: "" };

export function TemplateSettings() {
  const { t } = useLingui();
  const templates = AsyncResult.getOrElse(useAtomValue(templatesAtom), () => []);
  const remove = useAtomSet(deleteTemplateAtom);
  const [form, setForm] = useState<Form | null>(null);
  const open = (template: Template) =>
    setForm({
      id: template.id,
      name: template.name,
      subject: template.subject,
      to: template.to.map(formatAddress).join(", "),
      cc: template.cc.map(formatAddress).join(", "),
      bcc: (template.bcc ?? []).map(formatAddress).join(", "),
      body: template.body,
    });
  return (
    <section className="space-y-6">
      <SettingsGroup title={t`Templates`}>
        {templates.map((template) => (
          <div key={template.id} className="flex min-h-10 items-center gap-4 px-3 py-1.5">
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded-item text-left outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2"
              onClick={() => open(template)}
            >
              {template.name}
            </button>
            <button
              type="button"
              aria-label={t`Edit ${template.name}`}
              className={`shrink-0 ${buttonLink}`}
              onClick={() => open(template)}
            >{t`Edit`}</button>
            <button
              type="button"
              aria-label={t`Delete ${template.name}`}
              className={`${rowAction} text-a11y-danger`}
              onClick={() =>
                remove({ payload: { id: template.id }, reactivityKeys: [Keys.templates] })
              }
            >{t`Delete`}</button>
          </div>
        ))}
        <div className="flex justify-end px-3 py-2">
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => setForm({ ...blank })}
          >{t`New template`}</button>
        </div>
      </SettingsGroup>
      {form && <TemplateForm key={form.id ?? "new"} initial={form} onClose={() => setForm(null)} />}
    </section>
  );
}

function TemplateForm({ initial, onClose }: { initial: Form; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const token = "{project}";
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [state, save] = useAtom(saveTemplateAtom, { mode: "promiseExit" });

  const target = useRef<{ field: "subject" | "body"; start: number; end: number }>({
    field: "body",
    start: initial.body.length,
    end: initial.body.length,
  });
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const saveForm = () => {
    const to = parseAddresses(form.to),
      cc = parseAddresses(form.cc),
      bcc = parseAddresses(form.bcc);
    if (!form.name.trim()) {
      setError(t`Enter a template name.`);
      return;
    }
    if ([...to.invalid, ...cc.invalid, ...bcc.invalid].length) {
      setError(t`Enter valid email addresses in To, Cc and Bcc.`);
      return;
    }
    setError("");
    void save({
      payload: {
        ...(form.id ? { id: form.id } : {}),
        input: {
          name: form.name,
          subject: form.subject,
          body: form.body,
          to: to.addresses,
          cc: cc.addresses,
          bcc: bcc.addresses,
        },
      },
      reactivityKeys: [Keys.templates],
    }).then((exit) => {
      if (Exit.isSuccess(exit)) setForm((previous) => ({ ...previous, id: exit.value.id }));
      return exit;
    });
  };
  const insert = (variable: string) => {
    const { field, start, end } = target.current;
    const inserted = `{${variable}}`;
    setForm((previous) => ({
      ...previous,
      [field]: previous[field].slice(0, start) + inserted + previous[field].slice(end),
    }));
    const cursor = start + inserted.length;
    target.current = { field, start: cursor, end: cursor };
    requestAnimationFrame(() => {
      const element = field === "subject" ? subjectRef.current : bodyRef.current;
      element?.focus();
      element?.setSelectionRange(cursor, cursor);
    });
  };
  return (
    <fieldset className={editorCard}>
      <legend className={editorLegend}>{t`Edit template`}</legend>
      <div className="clear-both space-y-4">
        <label className="block">
          <span className={fieldLabel}>{t`Template name`}</span>
          <input
            className={formInput}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>{t`Subject`}</span>
          <input
            ref={subjectRef}
            className={formInput}
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            onSelect={(e) => {
              target.current = {
                field: "subject",
                start: e.currentTarget.selectionStart ?? 0,
                end: e.currentTarget.selectionEnd ?? 0,
              };
            }}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>{t`To`}</span>
          <input
            className={formInput}
            value={form.to}
            onChange={(e) => setForm({ ...form, to: e.target.value })}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>{t`Cc`}</span>
            <input
              className={formInput}
              value={form.cc}
              onChange={(e) => setForm({ ...form, cc: e.target.value })}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t`Bcc`}</span>
            <input
              className={formInput}
              value={form.bcc}
              onChange={(e) => setForm({ ...form, bcc: e.target.value })}
            />
          </label>
        </div>
        <div className="flex justify-end">
          <Select
            aria-label={t`Insert variable`}
            value=""
            options={[
              { value: "", label: t`Insert variable…` },
              ...TEMPLATE_VARIABLES.filter((key) => !key.startsWith("recipient_")).map((key) => ({
                value: key,
                label: i18n._(VARIABLE_LABELS[key]),
              })),
            ]}
            onValueChange={insert}
          />
        </div>
        <label className="-mt-2 block">
          <span className={fieldLabel}>
            {t({
              message: "Body",
              context: "message text",
              comment: "Email message text, never an anatomical body.",
            })}
          </span>
          <textarea
            ref={bodyRef}
            rows={7}
            className={formInput}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            onSelect={(e) => {
              target.current = {
                field: "body",
                start: e.currentTarget.selectionStart,
                end: e.currentTarget.selectionEnd,
              };
            }}
          />
        </label>
        <p
          className={`-mt-2 ${settingsHint}`}
        >{t`Use ${token} for a custom variable. You will be asked for its value when inserting the template.`}</p>
        {error && (
          <p role="alert" className="text-a11y-danger">
            {error}
          </p>
        )}
        {state._tag === "Failure" && (
          <p role="alert" className="text-a11y-danger">
            {causeText(i18n, state.cause)}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {state._tag === "Success" && !state.waiting && (
            <output className={`mr-auto ${settingsHint}`}>{t`Saved`}</output>
          )}
          <button type="button" className={buttonSecondary} onClick={onClose}>
            <Trans>Close</Trans>
          </button>
          <button
            type="button"
            className={buttonPrimary}
            disabled={state.waiting}
            onClick={saveForm}
          >
            <Trans>Save</Trans>
          </button>
        </div>
      </div>
    </fieldset>
  );
}
