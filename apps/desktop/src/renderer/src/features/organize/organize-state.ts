import { Atom } from "effect/reactivity";
import type { LabelApplyTarget } from "./CreateLabelDialog";

/** The reader toolbar's label picker, and whether it labels or moves. */
export const labelPickerAtom = Atom.make(false).pipe(Atom.keepAlive);
export const pickerModeAtom = Atom.make<"label" | "move">("label").pipe(Atom.keepAlive);

/** The rows a new label is for, while the create-label dialog is open. */
export const labelCreationAtom = Atom.make<LabelApplyTarget | null>(null).pipe(Atom.keepAlive);

/** The rows being snoozed, while the snooze dialog is open. */
export const snoozeIdsAtom = Atom.make<readonly string[] | null>(null).pipe(Atom.keepAlive);
