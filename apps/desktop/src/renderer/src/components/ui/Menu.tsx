import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentProps, ComponentType, ReactNode } from "react";

import { itemClass, kbdClass, popupMotion, popupSurface, separatorClass } from "./styles";

type Icon = ComponentType<{ className?: string }>;

const popup = `min-w-48 p-[5px] ${popupSurface} ${popupMotion}`;

/**
 * The popup of a context menu. ContextMenu parts other than Root, Trigger and
 * Positioner are the Menu parts, so the items below work in both.
 */
export function ContextMenuContent({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="z-[60] outline-none">
        <Menu.Popup className={popup}>{children}</Menu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
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
        <ContextMenu.Positioner className="z-[60] outline-none" alignOffset={-5} sideOffset={-2}>
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
export type ContextMenuRootProps = ComponentProps<typeof ContextMenu.Root>;
