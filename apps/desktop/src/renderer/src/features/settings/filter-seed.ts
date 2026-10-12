import { Atom } from "effect/reactivity";

/** The sender a new server filter starts from, while the filter editor is open. */
export const filterSeedAtom = Atom.make<{ accountId: string; from: string } | null>(null).pipe(
  Atom.keepAlive,
);
