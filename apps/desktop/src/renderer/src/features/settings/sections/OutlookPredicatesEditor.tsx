import {
  MESSAGE_ACTION_FLAGS,
  RULE_IMPORTANCE,
  RULE_SENSITIVITY,
  type OutlookRulePredicates,
} from "@openmail/core/schema";
import { useLingui } from "@lingui/react/macro";
import { importanceNames } from "../../../i18n/organization-labels";
import { fieldLabel } from "./server-settings-styles";
import { formInput } from "../../../ui/styles";
import { Select } from "../../../ui/Select";
import { Checkbox } from "../../../ui/Checkbox";

export function OutlookPredicatesEditor({
  value,
  onChange,
}: {
  value: OutlookRulePredicates;
  onChange: (value: OutlookRulePredicates) => void;
}) {
  const { t } = useLingui();
  const patch = (update: Partial<OutlookRulePredicates>) => {
    const next = { ...value, ...update };
    const entries: [string, unknown][] = Object.entries(next);
    onChange(Object.fromEntries(entries.filter(([, v]) => v !== undefined)));
  };
  const importance = importanceNames(t);
  const sensitivity = {
    normal: t`Normal`,
    personal: t`Personal`,
    private: t`Private`,
    confidential: t`Confidential`,
  };
  const flags = {
    any: t`Any action flag`,
    call: t`Call`,
    doNotForward: t({
      message: "Do not forward",
      comment: "Incoming message action flag value; this option does not execute forwarding.",
    }),
    followUp: t`Follow up`,
    fyi: t`For your information`,
    forward: t({
      message: "Forward",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    noResponseNecessary: t`No response needed`,
    read: t({
      message: "Read",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    reply: t({
      message: "Reply",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    replyToAll: t({
      message: "Reply all",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    review: t`Review`,
  };
  const selects = [
    {
      key: "importance",
      label: t`Importance condition`,
      value: value.importance ?? "",
      options: RULE_IMPORTANCE.map((entry) => ({ value: entry, label: importance[entry] })),
      onChange: (next: string) =>
        patch({ importance: RULE_IMPORTANCE.find((entry) => entry === next) }),
    },
    {
      key: "sensitivity",
      label: t`Sensitivity`,
      value: value.sensitivity ?? "",
      options: RULE_SENSITIVITY.map((entry) => ({ value: entry, label: sensitivity[entry] })),
      onChange: (next: string) =>
        patch({ sensitivity: RULE_SENSITIVITY.find((entry) => entry === next) }),
    },
    {
      key: "messageActionFlag",
      label: t`Message action flag`,
      value: value.messageActionFlag ?? "",
      options: MESSAGE_ACTION_FLAGS.map((entry) => ({ value: entry, label: flags[entry] })),
      onChange: (next: string) =>
        patch({ messageActionFlag: MESSAGE_ACTION_FLAGS.find((entry) => entry === next) }),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-3">
      {(
        [
          {
            key: "bodyContains",
            label: t({
              message: "Message text contains",
              comment: "Rule predicate matching the message text, excluding the subject.",
            }),
          },
          { key: "headerContains", label: t`Headers contain` },
        ] as const
      ).map(({ key, label }) => (
        <label key={key} className="block">
          <span className={fieldLabel}>{label}</span>
          <input
            className={formInput}
            value={value[key]?.[0] ?? ""}
            onChange={(e) => patch({ [key]: e.target.value ? [e.target.value] : undefined })}
          />
        </label>
      ))}
      {selects.map((select) => (
        // Not a label: a click on it would reach the select's hidden input, not its button.
        <div
          key={select.key}
          className={select.key === "messageActionFlag" ? "col-span-2" : undefined}
        >
          <span className={fieldLabel}>{select.label}</span>
          <Select
            aria-label={select.label}
            variant="field"
            value={select.value}
            options={[{ value: "", label: t`None` }, ...select.options]}
            onValueChange={select.onChange}
          />
        </div>
      ))}
      {(
        [
          { key: "minimumSize", label: t`Minimum size (KiB)` },
          { key: "maximumSize", label: t`Maximum size (KiB)` },
        ] as const
      ).map(({ key, label }) => (
        <label key={key} className="block">
          <span className={fieldLabel}>{label}</span>
          <input
            className={formInput}
            type="number"
            min="0"
            step="1"
            max="2147483647"
            value={value.withinSizeRange?.[key] ?? ""}
            onChange={(e) => {
              const range = { ...value.withinSizeRange };
              if (e.target.value) range[key] = Number(e.target.value);
              else delete range[key];
              patch({ withinSizeRange: Object.keys(range).length ? range : undefined });
            }}
          />
        </label>
      ))}
      {(
        [
          { key: "isAutomaticReply", label: t`Automatic reply` },
          { key: "sentToMe", label: t`To me` },
          { key: "sentOnlyToMe", label: t`Only to me` },
          { key: "sentCcMe", label: t`CC me` },
          { key: "notSentToMe", label: t`Not to me` },
          { key: "sentToOrCcMe", label: t`To or CC me` },
        ] as const
      ).map(({ key, label }) => (
        <label key={key} className="flex items-center gap-2">
          <Checkbox
            checked={value[key] ?? false}
            onCheckedChange={(checked) => patch({ [key]: checked ? true : undefined })}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}
