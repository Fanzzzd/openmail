import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { type ComponentProps, type ReactNode, useRef } from "react";
import { isDesktop } from "../lib/platform";
import { useLayoutMode } from "../lib/responsive-layout";
import { buttonDanger, buttonPrimary, buttonSecondary, iconButton } from "./styles";

type InitialFocus = ComponentProps<typeof BaseDialog.Popup>["initialFocus"];

const backdropMotion =
  "transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none";
const popupMotion =
  "transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-none";

/** The white sheet every dialog sits on. */
const sheet =
  "no-drag rounded-sheet bg-raised text-body text-neutral-900 shadow-sheet outline-none dark:text-neutral-100";

interface DialogProps {
  /** Called on Escape and outside clicks. Omit to make the dialog impossible to dismiss. */
  onClose?: (() => void) | undefined;
  "aria-label": string;
  /** Size and layout of the sheet. */
  className?: string;
  backdropClassName?: string;
  initialFocus?: InitialFocus;
  finalFocus?: ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
  /** The dialog draws its own close button, so a full-window sheet adds none. */
  ownClose?: boolean;
  /** Opens over another dialog. Base UI skips a nested dialog's backdrop unless forced, so the
   * dialog underneath would show through undimmed. */
  nested?: boolean;
  /** A lower cap on the centred sheet's height than the window's (see centredSheet). */
  maxHeight?: SheetCap;
  children: ReactNode;
}

/** Height caps a centred sheet may ask for, besides the window's. */
export type SheetCap = "600px" | "640px" | "720px" | "85vh";

// Written out whole so Tailwind finds every class.
const SHEET_CAPS: Record<"desktop" | "web", Record<SheetCap | "window", string>> = {
  desktop: {
    window: "sm:max-h-[calc(100dvh-2*var(--titlebar-clearance,12px))]",
    "600px": "sm:max-h-[min(600px,calc(100dvh-2*var(--titlebar-clearance,12px)))]",
    "640px": "sm:max-h-[min(640px,calc(100dvh-2*var(--titlebar-clearance,12px)))]",
    "720px": "sm:max-h-[min(720px,calc(100dvh-2*var(--titlebar-clearance,12px)))]",
    "85vh": "sm:max-h-[min(85vh,calc(100dvh-2*var(--titlebar-clearance,12px)))]",
  },
  web: {
    window: "sm:max-h-[calc(100dvh-24px)]",
    "600px": "sm:max-h-[min(600px,calc(100dvh-24px))]",
    "640px": "sm:max-h-[min(640px,calc(100dvh-24px))]",
    "720px": "sm:max-h-[min(720px,calc(100dvh-24px))]",
    "85vh": "sm:max-h-[min(85vh,calc(100dvh-24px))]",
  },
};

/**
 * The tallest a centred sheet gets, so its top edge clears the Mac's traffic
 * lights; the web build keeps a 12 px margin. `maxHeight` lowers it. Callers
 * set a width and, if the sheet has a fixed size, a height, but no max-h
 * class: this one wins at `sm`.
 */
export const centredSheet = (maxHeight?: SheetCap) =>
  SHEET_CAPS[isDesktop() ? "desktop" : "web"][maxHeight ?? "window"];

/**
 * Below MEDIUM_MIN (800 px, Tailwind's `sm`) a sheet fills the window, whatever size the caller asked for.
 * On the Mac its top stays clear for the traffic lights' row (`--titlebar-clearance`, from WindowChrome);
 * pair it with {@link SheetDragStrip}. A browser has no traffic lights, so the web build uses the whole height.
 */
export const narrowSheet = () =>
  `max-sm:inset-0 max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-none max-sm:rounded-none max-sm:data-ending-style:scale-none ${isDesktop() ? "max-sm:pt-(--titlebar-clearance)" : ""}`;

/** The titlebar of a full-window sheet: it drags the window, as the titlebar it covers did. None in a browser. */
export function SheetDragStrip() {
  if (!isDesktop()) return null;
  return (
    // Fixed, so it stays put and covers the content as a scrolling sheet passes under the lights.
    <div
      aria-hidden
      className="drag fixed inset-x-0 top-0 z-10 h-(--titlebar-clearance) bg-inherit sm:hidden"
    />
  );
}

/**
 * A centered modal dialog. It traps focus, closes on Escape and backdrop
 * clicks, and returns focus to where it was when it closes. The caller
 * mounts it while it should be open.
 */
export function Dialog({
  onClose,
  "aria-label": label,
  className = "",
  backdropClassName = "bg-black/30",
  initialFocus,
  finalFocus,
  ownClose = false,
  nested = false,
  maxHeight,
  children,
}: DialogProps) {
  const narrow = useLayoutMode() === "narrow";
  return (
    <BaseDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
      disablePointerDismissal={!onClose}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          forceRender={nested}
          className={`no-drag fixed inset-0 z-50 ${nested ? "bg-black/35 dark:bg-black/55" : backdropClassName} ${backdropMotion}`}
        />
        <BaseDialog.Popup
          aria-label={label}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          className={`fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ${sheet} ${popupMotion} ${className} ${className.includes("overflow-") ? "" : "overflow-y-auto"} ${centredSheet(maxHeight)} ${narrowSheet()}`}
        >
          <SheetDragStrip />
          {children}
          {narrow && onClose && !ownClose && <SheetClose />}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/**
 * A full-window sheet has no backdrop to click. It comes last in tab order, so
 * the dialog's own first control still gets focus.
 */
function SheetClose() {
  const { t } = useLingui();
  return (
    <BaseDialog.Close
      aria-label={t`Close`}
      className={`no-drag fixed top-2.5 right-3 z-20 text-a11y-muted ${iconButton} coarse:top-0 coarse:right-1`}
    >
      <X className="size-4" />
    </BaseDialog.Close>
  );
}

/**
 * A modal panel along the window's leading edge, for the sidebar when the
 * window is too narrow to dock it. Escape and backdrop clicks close it. Focus
 * starts on the current item, so the keyboard continues where the user is.
 */
export function Drawer({
  open,
  onOpenChange,
  "aria-label": label,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  "aria-label": string;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={`no-drag fixed inset-0 z-40 bg-black/30 ${backdropMotion}`}
        />
        <BaseDialog.Popup
          ref={popup}
          aria-label={label}
          initialFocus={() =>
            popup.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? true
          }
          // Focus returns to the toggle unless it already moved on, such as to the list of a mailbox picked here.
          finalFocus={() => {
            const active = document.activeElement;
            return !active || active === document.body || !!popup.current?.contains(active);
          }}
          className="no-drag fixed inset-y-0 left-0 z-40 flex max-h-none w-72 max-w-[calc(100vw-48px)] flex-col overflow-hidden bg-neutral-100 text-body text-neutral-900 shadow-sheet outline-none transition-transform duration-200 ease-out data-ending-style:-translate-x-full data-starting-style:-translate-x-full motion-reduce:transition-none dark:bg-neutral-900 dark:text-neutral-100"
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

interface AlertProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, right-aligned. Use `AlertCancel` for the dismiss button. */
  children: ReactNode;
}

/** A confirmation that needs an answer before anything else. Escape cancels. */
export function Alert({ open, onOpenChange, title, description, children }: AlertProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        {/* Forced: alerts usually sit over another dialog, which should dim too. */}
        <AlertDialog.Backdrop
          forceRender
          className={`no-drag fixed inset-0 z-50 bg-black/20 dark:bg-black/40 ${backdropMotion}`}
        />
        <AlertDialog.Popup
          className={`fixed top-1/2 left-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 p-5 ${sheet} ${popupMotion}`}
        >
          <AlertDialog.Title className="text-callout font-semibold">{title}</AlertDialog.Title>
          {description && (
            <AlertDialog.Description className="mt-1.5 text-a11y-muted">
              {description}
            </AlertDialog.Description>
          )}
          <div className="mt-5 flex justify-end gap-2">{children}</div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export const alertButton = buttonSecondary;
export const alertPrimary = buttonPrimary;
export const alertDanger = buttonDanger;

/** Closes the alert without doing anything. */
export function AlertCancel({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <AlertDialog.Close className={alertButton} disabled={disabled}>
      {children}
    </AlertDialog.Close>
  );
}
