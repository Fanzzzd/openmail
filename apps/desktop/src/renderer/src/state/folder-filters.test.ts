import { describe, expect, it } from "vitest";
import { Atom, AtomRegistry } from "effect/reactivity";
import { DEFAULT_LIST_FILTERS } from "@openmail/core/schema";
import type { View } from "../lib/view";
import {
  FILTER_STORAGE_KEY,
  makeFolderFiltersAtom,
  folderFilterKey,
  readFolderFilters,
  saveFolderFilters,
} from "./folder-filters";

describe("folder list filters", () => {
  it("keeps conditions when disabled and restores each folder, account and space", () => {
    const registry = AtomRegistry.make();
    const viewAtom = Atom.make<View>({ space: "all", mailbox: "inbox" });
    const filtersAtom = makeFolderFiltersAtom(viewAtom);
    try {
      const inbox = { space: "all", mailbox: "inbox" } as const;
      const chosen = { ...DEFAULT_LIST_FILTERS, enabled: true, unread: true, important: true };
      registry.set(viewAtom, inbox);
      registry.set(filtersAtom, chosen);
      registry.set(filtersAtom, { ...chosen, enabled: false });
      registry.set(viewAtom, {
        space: "all",
        mailbox: "all",
        label: { id: "label", accountId: "gmail:a" },
      });
      expect(registry.get(filtersAtom)).toEqual(DEFAULT_LIST_FILTERS);
      registry.set(filtersAtom, { ...chosen, inInbox: true });
      registry.set(viewAtom, { space: "all", mailbox: "inbox", accountId: "gmail:a" });
      expect(registry.get(filtersAtom)).toEqual(DEFAULT_LIST_FILTERS);
      registry.set(viewAtom, { ...inbox, space: "work" });
      expect(registry.get(filtersAtom)).toEqual(DEFAULT_LIST_FILTERS);
      registry.set(viewAtom, inbox);
      expect(registry.get(filtersAtom)).toEqual({ ...chosen, enabled: false });
      registry.set(filtersAtom, { ...registry.get(filtersAtom), enabled: true });
      expect(registry.get(filtersAtom)).toEqual(chosen);
      registry.set(viewAtom, {
        space: "all",
        mailbox: "all",
        label: { id: "label", accountId: "gmail:a" },
      });
      expect(registry.get(filtersAtom).inInbox).toBe(true);
    } finally {
      registry.dispose();
    }
  });
  it("persists folder identities and safely discards invalid or inaccessible storage", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const key = folderFilterKey({
      space: "all",
      mailbox: "all",
      label: { id: "a/b", accountId: "a" },
    });
    const filters = { ...DEFAULT_LIST_FILTERS, enabled: true, starred: true, inInbox: true };
    saveFolderFilters(storage, new Map([[key, filters]]));
    expect(readFolderFilters(storage).get(key)).toEqual(filters);
    const registry = AtomRegistry.make();
    const view = Atom.make<View>({
      space: "all",
      mailbox: "all",
      label: { id: "a/b", accountId: "a" },
    });
    try {
      const restored = makeFolderFiltersAtom(view, storage);
      expect(registry.get(restored)).toEqual(filters);
      registry.set(restored, { ...filters, enabled: false });
      const reopened = makeFolderFiltersAtom(view, storage);
      expect(registry.get(reopened)).toEqual({ ...filters, enabled: false });
    } finally {
      registry.dispose();
    }
    data.set(FILTER_STORAGE_KEY, '{"folder":{"unread":true}}');
    expect(readFolderFilters(storage).size).toBe(0);
    data.set(FILTER_STORAGE_KEY, "invalid JSON");
    expect(readFolderFilters(storage).size).toBe(0);
    expect(
      readFolderFilters({
        getItem: () => {
          throw new Error("denied");
        },
      }).size,
    ).toBe(0);
    expect(() =>
      saveFolderFilters(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        new Map(),
      ),
    ).not.toThrow();
    expect(key).not.toBe(
      folderFilterKey({ space: "all", mailbox: "all", label: { id: "a/b", accountId: "b" } }),
    );
  });
});
