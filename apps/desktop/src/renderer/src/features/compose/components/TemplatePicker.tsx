import type { ShortcutLabel } from "../../../../../shared/shortcuts";
import { useState, type ReactElement, type RefObject } from "react";
import { parseAddresses, type Draft } from "../draft";
import type { Template } from "../../../../../shared/api";
import type { ComposeElement } from "../compose-editor-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { templatesAtom } from "../../../state/queries";
import { saveTemplateAtom } from "../../../state/mutations";
import { ownText } from "@openmail/core/schema";
import { Keys } from "../../../state/keys";
import {
  PickerPopover,
  pickerFooter,
  pickerInput,
  pickerItem,
  pickerList,
} from "../../../ui/Picker";
import { Autocomplete } from "@base-ui/react/autocomplete";

/** ⌘/ in the compose window: pick a template to insert, or keep this message as one. */
export function TemplatePicker({
  open,
  onOpenChange,
  trigger,
  anchor,
  tip,
  draft,
  onInsert,
  bodyRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null when a menu item opens it; it then sits against `anchor`. */
  trigger: ReactElement | null;
  anchor?: Element | null | undefined;
  tip: { label: string; shortcut: ShortcutLabel | undefined };
  draft: Draft;
  onInsert: (t: Template) => void;
  bodyRef: RefObject<ComposeElement | null>;
}) {
  const { t } = useLingui();
  const templates = AsyncResult.getOrElse(useAtomValue(templatesAtom), () => []);
  const saveTemplate = useAtomSet(saveTemplateAtom);
  const [filter, setFilter] = useState("");
  const [naming, setNaming] = useState(false);
  // A template placeholder, shown as is.
  const token = "{first_name}";

  const reset = () => {
    setFilter("");
    setNaming(false);
  };

  const keep = () => {
    const name = filter.trim();
    if (!name) return;
    saveTemplate({
      payload: {
        input: {
          name,
          subject: draft.subject,
          to: parseAddresses(draft.to).addresses,
          cc: parseAddresses(draft.cc).addresses,
          bcc: parseAddresses(draft.bcc).addresses,
          body: ownText(draft.body.text),
        },
      },
      reactivityKeys: [Keys.templates],
    });
    onOpenChange(false);
    reset();
  };

  return (
    <PickerPopover
      aria-label={t`Templates`}
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      trigger={trigger}
      anchor={anchor}
      tip={tip}
      side="top"
      finalFocus={bodyRef}
      className="w-80"
    >
      {naming ? (
        <input
          // The footer button switched modes; typing continues here.
          autoFocus
          aria-label={t`Template name`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              keep();
            }
          }}
          placeholder={t`Name the template, then press Return`}
          className={pickerInput}
        />
      ) : (
        <Autocomplete.Root
          inline
          open
          items={templates}
          itemToStringValue={(tpl: Template) => tpl.name}
          value={filter}
          onValueChange={(v) => setFilter(v)}
          autoHighlight="always"
          keepHighlight
        >
          <Autocomplete.Input
            aria-label={t`Search templates`}
            placeholder={t`Templates…`}
            className={pickerInput}
          />
          {templates.length === 0 && (
            <p className="px-3 py-2 text-a11y-muted">
              <Trans>No templates yet. Use {token} for the first recipient's name.</Trans>
            </p>
          )}
          <Autocomplete.List className={pickerList}>
            {(tpl: Template) => (
              <Autocomplete.Item
                key={tpl.id}
                value={tpl}
                onClick={() => {
                  onInsert(tpl);
                  reset();
                }}
                className={pickerItem}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{tpl.name}</span>
                  <span className="block truncate text-footnote text-a11y-muted group-data-highlighted:text-white">
                    {tpl.subject || tpl.body.replace(/\s+/g, " ").slice(0, 60)}
                  </span>
                </span>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </Autocomplete.Root>
      )}
      <button
        type="button"
        onClick={() => {
          if (naming) {
            keep();
          } else {
            setNaming(true);
            setFilter("");
          }
        }}
        className={pickerFooter}
      >
        {naming ? <Trans>Save</Trans> : <Trans>Save this message as a template…</Trans>}
      </button>
    </PickerPopover>
  );
}
