import { DEFAULT_LIST_FILTERS, ListFilters } from "@openmail/core/schema";
import { Atom } from "effect/reactivity";
import { Schema } from "effect";
import type { View } from "../view";

export const FILTER_STORAGE_KEY = "openmail.folderFilters";
export function folderFilterKey(view: View): string {
  return JSON.stringify([
    view.space,
    view.accountId ?? null,
    view.mailbox,
    view.label?.accountId ?? null,
    view.label?.id ?? null,
  ]);
}
const SavedFilters = Schema.fromJsonString(Schema.Record(Schema.String, ListFilters));
export function readFolderFilters(
  storage: Pick<Storage, "getItem">,
): ReadonlyMap<string, ListFilters> {
  try {
    const raw = storage.getItem(FILTER_STORAGE_KEY);
    return raw ? new Map(Object.entries(Schema.decodeUnknownSync(SavedFilters)(raw))) : new Map();
  } catch {
    return new Map();
  }
}
export function saveFolderFilters(
  storage: Pick<Storage, "setItem">,
  filters: ReadonlyMap<string, ListFilters>,
): void {
  try {
    storage.setItem(FILTER_STORAGE_KEY, JSON.stringify(Object.fromEntries(filters)));
  } catch {
    // A denied/full local storage still permits session-local filtering.
  }
}
export function makeFolderFiltersAtom(
  view: Atom.Atom<View>,
  storage?: Pick<Storage, "getItem" | "setItem">,
) {
  const saved = Atom.make<ReadonlyMap<string, ListFilters>>(
    storage ? readFolderFilters(storage) : new Map(),
  ).pipe(Atom.keepAlive);
  return Atom.writable(
    (get) => get(saved).get(folderFilterKey(get(view))) ?? DEFAULT_LIST_FILTERS,
    (ctx, filters: ListFilters) => {
      const next = new Map(ctx.get(saved)).set(folderFilterKey(ctx.get(view)), filters);
      ctx.set(saved, next);
      if (storage) saveFolderFilters(storage, next);
    },
  );
}
