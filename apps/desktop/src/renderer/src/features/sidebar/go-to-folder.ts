import { Atom } from "effect/reactivity";

/** Whether the Go to Folder picker is open. */
export const goToFolderAtom = Atom.make(false).pipe(Atom.keepAlive);
