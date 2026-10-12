import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useSyncExternalStore } from "react";

import { Alert, AlertCancel } from "./Dialog";
import { buttonDanger, buttonPrimary } from "./styles";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Draws the confirm button in the danger style. */
  destructive?: boolean;
  /** Called once the dialog has painted, when it is the one on screen. */
  onShown?: () => void;
  /** Aborting withdraws the confirmation; it resolves false. */
  signal?: AbortSignal;
}
interface Request extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

let queue: readonly Request[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly Request[]) => {
  queue = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The window's replacement for window.confirm: resolves true when the person
 * confirms, false on Cancel or Escape. Needs a mounted ConfirmHost.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const request: Request = { ...options, resolve };
    if (options.signal?.aborted) {
      resolve(false);
      return;
    }
    options.signal?.addEventListener("abort", () => settle(request, false), { once: true });
    publish([...queue, request]);
  });
}

/** True while a confirmation is showing or queued; window shortcuts stay off meanwhile. */
export const confirmOpen = () => queue.length > 0;

function settle(request: Request, confirmed: boolean) {
  if (!queue.includes(request)) return;
  publish(queue.filter((item) => item !== request));
  request.resolve(confirmed);
}

/** Shows queued confirmations one at a time. Mount once per window. */
export function ConfirmHost() {
  const { t } = useLingui();
  const current = useSyncExternalStore(subscribe, () => queue[0]);
  useEffect(() => {
    const shown = current?.onShown;
    // After the commit that mounts the dialog, the next frame has painted it.
    const frame = shown ? requestAnimationFrame(() => requestAnimationFrame(shown)) : 0;
    return () => cancelAnimationFrame(frame);
  }, [current]);
  if (!current) return null;
  return (
    <Alert
      key={queue.indexOf(current)}
      open
      onOpenChange={(open) => {
        if (!open) settle(current, false);
      }}
      title={current.title}
      description={current.description}
    >
      <AlertCancel>{current.cancelLabel ?? t`Cancel`}</AlertCancel>
      <AlertDialog.Close
        className={current.destructive ? buttonDanger : buttonPrimary}
        onClick={() => settle(current, true)}
      >
        {current.confirmLabel}
      </AlertDialog.Close>
    </Alert>
  );
}
