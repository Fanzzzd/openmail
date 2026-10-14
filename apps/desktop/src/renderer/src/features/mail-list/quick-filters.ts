import type { Filters } from "../../lib/view";

/** A chip under the "Quick filters" switch. */
export type QuickFilter = "unread" | "starred" | "important" | "inInbox";

const NONE = { unread: false, starred: false, important: false, inInbox: false } as const;

/**
 * Whether a sub-chip filters the list now. The switch remembers the chosen chips while it is
 * off, but the list ignores them then, so they show as off too.
 */
export function quickFilterOn(filters: Filters, key: QuickFilter): boolean {
  return filters.enabled && filters[key];
}

/**
 * The filters after a sub-chip press. With the switch on, the chip toggles alone. With it off,
 * the press turns the switch on with only that chip, so no remembered chip comes back unseen.
 */
export function pressQuickFilter(filters: Filters, key: QuickFilter, on: boolean): Filters {
  return filters.enabled
    ? { ...filters, [key]: on }
    : { ...filters, ...NONE, [key]: on, enabled: true };
}
