import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { type ComponentProps, type ReactNode, useRef } from "react";
import { useLayoutMode } from "../../responsive-layout";

type InitialFocus = ComponentProps<typeof BaseDialog.Popup>["initialFocus"];

const backdropMotion =
  "transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none";
const popupMotion =
  "transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-none";

/** The white sheet every dialog sits on. */
const sheet =
  "no-drag rounded-xl bg-white text-[13px] text-neutral-900 shadow-2xl ring-1 ring-black/5 outline-none dark:bg-neutral-800 dark:text-neutral-100 dark:ring-white/10";

interface DialogProps {
  /** Called on Escape and outside clicks. Omit to make the dialog impossible to dismiss. */
  onClose?: (() => void) | undefined;
  "aria-label": string;
  /** Size and layout of the sheet. */
  className?: string;
  backdropClassName?: string;
  initialFocus?: InitialFocus;
  finalFocus?: ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
  children: ReactNode;
}

/** Below 640 px a dialog fills the window, whatever size the caller asked for. */
const narrowSheet =
  "max-sm:inset-0 max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none";

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
          className={`no-drag fixed inset-0 z-50 ${backdropClassName} ${backdropMotion}`}
        />
        <BaseDialog.Popup
          aria-label={label}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          className={`fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ${sheet} ${popupMotion} ${className} ${narrowSheet}`}
        >
          {children}
          {narrow && onClose && <SheetClose />}
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
      className="absolute top-2.5 right-3 rounded-md p-1 text-a11y-muted hover:bg-black/5 dark:hover:bg-white/10"
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
          className="no-drag fixed inset-y-0 left-0 z-40 flex max-h-none w-72 max-w-[calc(100vw-48px)] flex-col overflow-hidden bg-neutral-100 text-[13px] text-neutral-900 shadow-2xl outline-none transition-transform duration-200 ease-out data-ending-style:-translate-x-full data-starting-style:-translate-x-full motion-reduce:transition-none dark:bg-neutral-900 dark:text-neutral-100"
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
          <AlertDialog.Title className="text-[14px] font-semibold">{title}</AlertDialog.Title>
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

export const alertButton =
  "h-7 whitespace-nowrap rounded-md border border-black/10 px-3 font-medium outline-offset-1 outline-a11y-focus hover:bg-black/[0.04] focus-visible:outline-[3px] dark:border-white/15 dark:hover:bg-white/5";
export const alertPrimary =
  "h-7 whitespace-nowrap rounded-md bg-blue-600 px-3 font-medium text-white outline-offset-1 outline-a11y-focus hover:bg-blue-700 focus-visible:outline-[3px] disabled:opacity-50";
export const alertDanger =
  "h-7 whitespace-nowrap rounded-md bg-red-600 px-3 font-medium text-white outline-offset-1 outline-red-500/60 hover:bg-red-700 focus-visible:outline-[3px] disabled:opacity-50";

/** Closes the alert without doing anything. */
export function AlertCancel({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <AlertDialog.Close className={alertButton} disabled={disabled}>
      {children}
    </AlertDialog.Close>
  );
}
