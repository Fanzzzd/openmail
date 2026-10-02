import { Exit } from "effect";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { TEMPLATE_VARIABLES } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import type { Template } from "../../../shared/api";
import { formatAddress, parseAddresses } from "../draft";
import { causeText } from "../errors";
import { Keys } from "../state/keys";
import { deleteTemplateAtom, saveTemplateAtom } from "../state/mutations";
import { templatesAtom } from "../state/queries";
import { Select } from "./ui/Select";

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
const fieldClass =
  "w-full rounded border border-black/10 bg-transparent px-2 py-1.5 outline-blue-500 dark:border-white/15";
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
    <section className="space-y-3">
      <h3 className="text-[12px] font-semibold text-a11y-muted">{t`Templates`}</h3>
      <button
        type="button"
        className="rounded border px-3 py-1"
        onClick={() => setForm({ ...blank })}
      >{t`New template`}</button>
      {templates.map((template) => (
        <div key={template.id} className="flex items-center gap-3">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-a11y-accent"
            onClick={() => open(template)}
          >
            {template.name}
          </button>
          <button
            type="button"
            aria-label={t`Edit ${template.name}`}
            onClick={() => open(template)}
          >{t`Edit`}</button>
          <button
            type="button"
            aria-label={t`Delete ${template.name}`}
            className="text-a11y-danger"
            onClick={() =>
              remove({ payload: { id: template.id }, reactivityKeys: [Keys.templates] })
            }
          >{t`Delete`}</button>
        </div>
      ))}
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
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend>{t`Edit template`}</legend>
      <label className="block">
        {t`Template name`}
        <input
          className={fieldClass}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label className="block">
        {t`Subject`}
        <input
          ref={subjectRef}
          className={fieldClass}
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
        {t`To`}
        <input
          className={fieldClass}
          value={form.to}
          onChange={(e) => setForm({ ...form, to: e.target.value })}
        />
      </label>
      <label className="block">
        {t`Cc`}
        <input
          className={fieldClass}
          value={form.cc}
          onChange={(e) => setForm({ ...form, cc: e.target.value })}
        />
      </label>
      <label className="block">
        {t`Bcc`}
        <input
          className={fieldClass}
          value={form.bcc}
          onChange={(e) => setForm({ ...form, bcc: e.target.value })}
        />
      </label>
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
      <label className="block">
        {t({
          message: "Body",
          context: "message text",
          comment: "Email message text, never an anatomical body.",
        })}
        <textarea
          ref={bodyRef}
          rows={7}
          className={fieldClass}
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
      <p className="text-a11y-muted">{t`Use ${token} for a custom variable. You will be asked for its value when inserting the template.`}</p>
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
      {state._tag === "Success" && !state.waiting && <output>{t`Saved`}</output>}
      <div className="flex gap-3">
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1 text-white"
          disabled={state.waiting}
          onClick={saveForm}
        >
          <Trans>Save</Trans>
        </button>
        <button type="button" onClick={onClose}>
          <Trans>Close</Trans>
        </button>
      </div>
    </fieldset>
  );
}
