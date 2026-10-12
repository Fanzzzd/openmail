import { Atom } from "effect/reactivity";
import type { Profile } from "../../../../shared/api";

/** The profile open in the profile editor, or "new" for a new one. */
export const editingProfileAtom = Atom.make<Profile | "new" | null>(null).pipe(Atom.keepAlive);
