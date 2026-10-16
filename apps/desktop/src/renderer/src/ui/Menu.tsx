import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ComponentProps, ComponentType, MouseEvent, ReactElement, ReactNode } from "react";

import { useOpenSurface } from "./open-surfaces";
import { itemClass, kbdClass, popupMotion, popupSurface, separatorClass } from "./styles";

type Icon = ComponentType<{ className?: string }>;

const popup = `min-w-48 overflow-y-auto p-[5px] ${popupSurface} ${popupMotion}`;

/**
 * The popup of a context menu. ContextMenu parts other than Root, Trigger and
 * Positioner are the Menu parts, so the items below work in both.
 */
export function ContextMenuContent({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="z-[60] outline-none">
        <section aria-label={label}>
          <Menu.Popup aria-label={label} className={popup}>
            {children}
          </Menu.Popup>
        </section>
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
  describedBy,
  label,
}: {
  trigger: ReactElement;
  align?: "start" | "center" | "end";
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The id of text in the menu that describes it, read when the menu opens. */
  describedBy?: string;
  /** The menu's accessible name, for example "Folder actions". */
  label: string;
}) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const change = (next: boolean) => {
    setInner(next);
    onOpenChange?.(next);
  };
  useOpenSurface(isOpen, () => change(false));
  return (
    <Menu.Root open={isOpen} onOpenChange={change}>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner className="z-[60] outline-none" align={align} sideOffset={4}>
          <section aria-label={label}>
            <Menu.Popup aria-label={label} aria-describedby={describedBy} className={popup}>
              {children}
            </Menu.Popup>
          </section>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

interface ItemProps {
  icon?: Icon | undefined;
  /** Shown right-aligned, for example "E". Not translated. */
  shortcut?: string | undefined;
  /** The event's currentTarget is the item, while the menu is still open. */
  onClick: (event: MouseEvent<HTMLElement>) => void;
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
      <Menu.GroupLabel className="px-2 pt-1 pb-0.5 text-caption font-semibold text-a11y-muted">
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
  label: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger
        className={`group ${itemClass} data-popup-open:not-data-highlighted:bg-fill-hover`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {Icon && <Icon className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className="ml-4 size-3.5 opacity-60" />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-[60] outline-none" alignOffset={-5} sideOffset={-2}>
          <section aria-label={label}>
            <Menu.Popup
              aria-label={label}
              className={`max-h-[min(var(--available-height),320px)] overflow-y-auto ${popup}`}
            >
              {children}
            </Menu.Popup>
          </section>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}

/** A context menu's root. It registers as an open surface, so Close window closes the menu first. */
export function ContextMenuRoot({
  onOpenChange,
  ...props
}: ComponentProps<typeof ContextMenu.Root>) {
  const [open, setOpen] = useState(false);
  useOpenSurface(open, () => setOpen(false));
  return (
    <ContextMenu.Root
      {...props}
      open={open}
      onOpenChange={(next, details) => {
        onOpenChange?.(next, details);
        if (!details.isCanceled) setOpen(next);
      }}
    />
  );
}
export const ContextMenuTrigger = ContextMenu.Trigger;
