import { categoryKey, mergeCategoryNames, providerCapabilities } from "@openmail/core/schema";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { cloneElement, type ReactElement, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { Label, Provider } from "../../../../shared/api";
import { MenuItem } from "../../ui/Menu";
import { PickerPopover } from "../../ui/Picker";
import { buttonPrimary, formInput } from "../../ui/styles";
import {
  multiOrganizationAtom,
  type OrganizationRequest,
  type OrganizationTarget,
} from "./organize-state";

/**
 * Whether the form has anything to offer: Outlook categories always take new names, while an
 * account without folders has nowhere to copy to.
 */
export const offersOrganization = (provider: Provider, labels: readonly Label[]) =>
  providerCapabilities(provider).categories ||
  labels.some((label) => !label.id.startsWith("category:"));

/**
 * What opened a menu, for a form that outlives it: the row whose context menu it is, else the
 * button whose menu it is, else the item itself.
 */
export function menuOpener(item: Element | null): Element | null {
  const menu = item?.closest('[role="menu"]');
  const button = menu?.id
    ? document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`)
    : null;
  return document.querySelector("[data-menu-open]") ?? button ?? item ?? null;
}

function useTitle(provider: Provider) {
  const { t } = useLingui();
  return providerCapabilities(provider).categories ? t`Categories…` : t`Copy to folders…`;
}

/**
 * Outlook categories stack; IMAP copies create separate messages in each
 * chosen folder. The form opens in a popover anchored to `trigger`, as in a
 * toolbar.
 */
export function MultiOrganization({
  trigger,
  ...target
}: OrganizationTarget & {
  /** The button that opens the popover, without content; the label goes inside. */
  trigger: ReactElement<{ children?: string }>;
}) {
  const title = useTitle(target.provider);
  const [open, setOpen] = useState(false);
  return (
    <PickerPopover
      aria-label={title}
      open={open}
      onOpenChange={setOpen}
      trigger={cloneElement(trigger, {}, title)}
      className="w-72 px-3 py-1"
    >
      <OrganizationForm {...target} onDone={() => setOpen(false)} />
    </PickerPopover>
  );
}

/** The menu's way in: a menu item that opens the same form once the menu closes. */
export function MultiOrganizationItem(target: OrganizationTarget) {
  const title = useTitle(target.provider);
  const request = useAtomSet(multiOrganizationAtom);
  if (!offersOrganization(target.provider, target.labels)) return null;
  return (
    <MenuItem
      onClick={(event) => {
        // The item goes away with the menu; the form opens at what opened the menu.
        const opener = menuOpener(event.currentTarget);
        const rect = opener?.getBoundingClientRect() ?? DOMRect.fromRect();
        request({
          ...target,
          anchor: {
            getBoundingClientRect: () =>
              opener?.isConnected ? opener.getBoundingClientRect() : rect,
          },
        });
      }}
    >
      {title}
    </MenuItem>
  );
}

/** Shows the form a menu item asked for. Mount once per window. */
export function MultiOrganizationHost() {
  const [request, setRequest] = useAtom(multiOrganizationAtom);
  return request && <RequestedForm request={request} onClose={() => setRequest(null)} />;
}

function RequestedForm({
  request: { anchor, ...target },
  onClose,
}: {
  request: OrganizationRequest;
  onClose: () => void;
}) {
  const title = useTitle(target.provider);
  return (
    <PickerPopover
      aria-label={title}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      trigger={null}
      anchor={anchor}
      className="w-72 px-3 py-1"
    >
      <OrganizationForm {...target} onDone={onClose} />
    </PickerPopover>
  );
}

/** Starts from the thread's current categories and no new names each time it opens. */
function OrganizationForm({
  provider,
  labels,
  current,
  onOp,
  onDone,
}: OrganizationTarget & { onDone: () => void }) {
  const { t } = useLingui();
  const categories = providerCapabilities(provider).categories;
  const available = labels.filter((label) => categories === label.id.startsWith("category:"));
  const [selected, setSelected] = useState<string[]>(() =>
    categories
      ? available
          .filter((label) => current.some((id) => categoryKey(id) === categoryKey(label.id)))
          .map((label) => label.id)
      : [],
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [names, setNames] = useState("");
  return (
    <fieldset className="space-y-2 py-2">
      <legend className="text-footnote text-a11y-muted">
        {categories
          ? t`Choose multiple categories`
          : t`Creates a separate copy in each selected folder. Keeps the original. Copies cannot be undone.`}
      </legend>
      <div className="max-h-40 overflow-auto">
        {available.map((label) => (
          <label key={label.id} className="flex items-center gap-2 py-1">
            <input
              type="checkbox"
              className="size-3.5 accent-blue-600"
              checked={selected.includes(label.id)}
              onChange={(event) => {
                setTouched((previous) => new Set([...previous, label.id]));
                setSelected((previous) =>
                  event.target.checked
                    ? [...previous, label.id]
                    : previous.filter((id) => id !== label.id),
                );
              }}
            />
            {label.name}
          </label>
        ))}
      </div>
      {categories && (
        <label className="block">
          {t`Additional category names, separated by commas`}
          <input
            className={`mt-1 ${formInput}`}
            value={names}
            onChange={(event) => setNames(event.target.value)}
          />
        </label>
      )}
      <button
        type="button"
        className={buttonPrimary}
        disabled={!categories && !selected.length}
        onClick={() => {
          if (categories) {
            const wanted = mergeCategoryNames(
              selected.map((id) => id.slice(9)),
              names
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean),
              [],
            );
            onOp({
              kind: "categories",
              add: wanted,
              remove: [...touched]
                .filter(
                  (id) =>
                    id.startsWith("category:") &&
                    !wanted.some((name) => categoryKey(name) === categoryKey(id.slice(9))),
                )
                .map((id) => id.slice(9)),
            });
          } else onOp({ kind: "copy", labelIds: selected });
          onDone();
        }}
      >
        {categories ? t`Apply` : t`Copy`}
      </button>
    </fieldset>
  );
}
