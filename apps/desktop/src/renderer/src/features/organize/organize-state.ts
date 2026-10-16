import { Atom } from "effect/reactivity";
import type { LabelApplyTarget } from "./CreateLabelDialog";
import type { Label, MailOp, Provider } from "../../../../shared/api";

/** The reader toolbar's label picker, and whether it labels or moves. */
export const labelPickerAtom = Atom.make(false).pipe(Atom.keepAlive);
export const pickerModeAtom = Atom.make<"label" | "move">("label").pipe(Atom.keepAlive);

/** The rows a new label is for, while the create-label dialog is open. */
export const labelCreationAtom = Atom.make<LabelApplyTarget | null>(null).pipe(Atom.keepAlive);

/** The rows being snoozed, while the snooze dialog is open. */
export const snoozeIdsAtom = Atom.make<readonly string[] | null>(null).pipe(Atom.keepAlive);

/** The conversation the form organizes and how to apply the result. */
export interface OrganizationTarget {
  provider: Provider;
  labels: readonly Label[];
  current: readonly string[];
  onOp: (op: MailOp) => void;
}

/** A form opened from a menu item: the menu closes, so the form opens where the item was. */
export interface OrganizationRequest extends OrganizationTarget {
  anchor: { getBoundingClientRect: () => DOMRect };
}

/** The copy-to-folders or categories form a menu item opened, until it closes. */
export const multiOrganizationAtom = Atom.make<OrganizationRequest | null>(null).pipe(
  Atom.keepAlive,
);
