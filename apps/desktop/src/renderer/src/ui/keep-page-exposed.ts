import { constVoid } from "effect/Function";
import { useLayoutEffect } from "react";

/**
 * Base UI hides everything outside a typeable combobox and its popup with aria-hidden while the
 * popup is open, but leaves it focusable and clickable. Screen readers then meet focusable
 * content they were told to ignore, and a narrow window loses its h1. The combobox pattern needs
 * no such hiding: focus stays in the field and aria-activedescendant names the option. While
 * `open`, this takes back each aria-hidden that appears on an element that had none. The app
 * sets aria-hidden as it creates an element, which reports no such change; only TriageChip's
 * compact form toggles it later, and a resize while a popup is open is the only way to reach that.
 */
export function useKeepPageExposed(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return constVoid;
    const observer = new MutationObserver((records) => {
      for (const { target, oldValue } of records)
        if (
          target instanceof Element &&
          oldValue === null &&
          target.getAttribute("aria-hidden") === "true"
        )
          target.removeAttribute("aria-hidden");
    });
    observer.observe(document.body, {
      attributeFilter: ["aria-hidden"],
      attributeOldValue: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [open]);
}
