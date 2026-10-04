import { useLingui } from "@lingui/react/macro";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { itemClass, kbdClass, popupMotion, popupSurface, separatorClass } from "./styles";

type Icon = ComponentType<{ className?: string }>;

const popup = `min-w-48 overflow-y-auto p-[5px] ${popupSurface} ${popupMotion}`;

/**
 * The popup of a context menu. ContextMenu parts other than Root, Trigger and
 * Positioner are the Menu parts, so the items below work in both.
 */
export function ContextMenuContent({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner
        render={<section aria-label={t`More actions`} />}
        className="z-[60] outline-none"
      >
        <Menu.Popup className={popup}>{children}</Menu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}

/**
 * A menu that opens from a button, like a toolbar's More button. `trigger`
 * is the button element; it gets the open state and ARIA attributes.
 */
export function DropdownMenu({
  trigger,
  align = "end",
  children,
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  align?: "start" | "center" | "end";
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner
          render={<section aria-label={t`More actions`} />}
          className="z-[60] outline-none"
          align={align}
          sideOffset={4}
        >
          <Menu.Popup className={popup}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

interface ItemProps {
  icon?: Icon | undefined;
  /** Shown right-aligned, for example "E". Not translated. */
  shortcut?: string | undefined;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}

export function MenuItem({ icon: Icon, shortcut, onClick, disabled, children }: ItemProps) {
  return (
    <Menu.Item onClick={onClick} disabled={disabled} className={`group ${itemClass}`}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {Icon && <Icon className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <kbd className={`ml-4 ${kbdClass}`}>{shortcut}</kbd>}
    </Menu.Item>
  );
}

export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Menu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      closeOnClick
      className={`group ${itemClass}`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Menu.CheckboxItemIndicator>
          <Check className="size-3.5" />
        </Menu.CheckboxItemIndicator>
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </Menu.CheckboxItem>
  );
}

/** A labelled set of choices, such as the values of one setting. The current one has a check mark. */
export function MenuRadioGroup<V extends string>({
  label,
  value,
  options,
  onValueChange,
  disabled,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onValueChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <Menu.RadioGroup
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      <Menu.GroupLabel className="px-2 pt-1 pb-0.5 text-[11px] font-semibold text-a11y-muted">
        {label}
      </Menu.GroupLabel>
      {options.map((option) => (
        <Menu.RadioItem
          key={option.value}
          value={option.value}
          closeOnClick
          className={`group ${itemClass}`}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Menu.RadioItemIndicator>
              <Check className="size-3.5" />
            </Menu.RadioItemIndicator>
          </span>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

export function MenuSeparator() {
  return <Menu.Separator className={separatorClass} />;
}

/** A nested menu inside a context menu. */
export function ContextSubmenu({
  icon: Icon,
  label,
  children,
}: {
  icon?: Icon;
  label: ReactNode;
  children: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger
        className={`group ${itemClass} data-popup-open:not-data-highlighted:bg-black/[0.06] dark:data-popup-open:not-data-highlighted:bg-white/10`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {Icon && <Icon className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className="ml-4 size-3.5 opacity-60" />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner
          render={<section aria-label={t`More actions`} />}
          className="z-[60] outline-none"
          alignOffset={-5}
          sideOffset={-2}
        >
          <Menu.Popup
            className={`max-h-[min(var(--available-height),320px)] overflow-y-auto ${popup}`}
          >
            {children}
          </Menu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}

export const ContextMenuRoot = ContextMenu.Root;
export const ContextMenuTrigger = ContextMenu.Trigger;
