import { useSyncExternalStore } from "react";

/** Searches the person ran, newest first. Kept on this device only. */
export const RECENT_SEARCH_LIMIT = 8;
const KEY = "openmail.recentSearches";

/** Adds `query` as the newest entry; repeats move to the front, case-insensitively. */
export function addRecentSearch(list: readonly string[], query: string): string[] {
  const text = query.trim().replace(/\s+/g, " ");
  if (!text) return [...list];
  const key = text.toLocaleLowerCase();
  return [text, ...list.filter((item) => item.toLocaleLowerCase() !== key)].slice(
    0,
    RECENT_SEARCH_LIMIT,
  );
}

/** Stored JSON from an older or edited profile is checked before use. */
export function parseRecentSearches(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string" && item.trim() !== "")
          .slice(0, RECENT_SEARCH_LIMIT)
      : [];
  } catch {
    return [];
  }
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Storage | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;

const listeners = new Set<() => void>();
let cache: { raw: string | null; list: string[] } | undefined;

function read(): string[] {
  const raw = storage()?.getItem(KEY) ?? null;
  if (cache?.raw !== raw) cache = { raw, list: parseRecentSearches(raw) };
  return cache.list;
}

function write(list: readonly string[]) {
  const store = storage();
  if (!store) return;
  if (list.length) store.setItem(KEY, JSON.stringify(list));
  else store.removeItem(KEY);
  for (const listener of listeners) listener();
}

export const recentSearches = {
  add: (query: string) => write(addRecentSearch(read(), query)),
  remove: (query: string) => write(read().filter((item) => item !== query)),
  clear: () => write([]),
};

export function useRecentSearches(): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    read,
  );
}
