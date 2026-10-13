import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { Mailbox } from "../../../../shared/api";
import { Trans } from "@lingui/react/macro";
import { FileText, Inbox, ListFilter, SearchX, Star } from "lucide-react";

export interface EmptyActions {
  onClearSearch: () => void;
  onCompose: () => void;
  onSync: () => void;
  /** A sync is running, so Sync now has nothing to start. */
  syncing: boolean;
}

function EmptyListButton({
  onClick,
  focusLost,
  children,
}: {
  onClick: () => void;
  /** Set when the button leaves the document while it has focus. */
  focusLost: RefObject<boolean>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // An unmount cleanup in a layout effect runs while the button is still in the document.
  useLayoutEffect(() => {
    const button = ref.current;
    return () => {
      if (button && document.activeElement === button) focusLost.current = true;
    };
  }, [focusLost]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="mt-2 rounded-item font-medium text-a11y-accent hover:underline dark:text-blue-400"
    >
      {children}
    </button>
  );
}

/** Why the list is empty, with the step that changes it. */
export function EmptyList({
  searching,
  filtered,
  mailbox,
  onClearFilters,
  actions,
}: {
  searching: boolean;
  filtered: boolean;
  mailbox: Mailbox;
  onClearFilters: () => void;
  actions: EmptyActions | undefined;
}) {
  // Sync now goes away once the sync starts; focus moves to the status line instead of the body.
  const status = useRef<HTMLOutputElement>(null);
  const lostFocus = useRef(false);
  useEffect(() => {
    if (!lostFocus.current) return;
    lostFocus.current = false;
    status.current?.focus();
  });
  let text: ReactNode = <Trans>No messages here</Trans>;
  let Icon = Inbox;
  let button: { label: ReactNode; onClick: () => void } | undefined = actions && {
    label: <Trans>Sync now</Trans>,
    onClick: actions.onSync,
  };
  if (searching) {
    text = <Trans>No matching messages</Trans>;
    Icon = SearchX;
    button = actions && { label: <Trans>Clear search</Trans>, onClick: actions.onClearSearch };
  } else if (filtered) {
    text = <Trans>No messages match the filters</Trans>;
    Icon = ListFilter;
    button = { label: <Trans>Turn off filters</Trans>, onClick: onClearFilters };
  } else if (mailbox === "drafts") {
    text = <Trans>No drafts</Trans>;
    Icon = FileText;
    button = actions && { label: <Trans>New message</Trans>, onClick: actions.onCompose };
  } else if (mailbox === "starred") {
    text = <Trans>No starred messages. Star a message to find it here.</Trans>;
    Icon = Star;
    button = undefined;
  } else if (actions?.syncing) {
    // During the first sync the list is empty only because nothing has arrived yet.
    text = <Trans>Syncing mail…</Trans>;
    button = undefined;
  }
  return (
    <div className="flex shrink-0 flex-col items-center px-8 pt-16 pb-4 text-center text-a11y-muted">
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className="mb-3 size-8 text-neutral-300 dark:text-neutral-600"
      />
      <output ref={status} tabIndex={-1} className="block max-w-56 outline-none">
        {text}
      </output>
      {button && (
        <EmptyListButton onClick={button.onClick} focusLost={lostFocus}>
          {button.label}
        </EmptyListButton>
      )}
    </div>
  );
}
