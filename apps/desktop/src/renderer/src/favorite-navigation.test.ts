import { expect, it } from "vitest";
import { numberedFavorites, favoriteView } from "./favorite-navigation";
import { favoriteShortcut, spaceShortcut } from "../../shared/shortcuts";
import type { Account, Label, Profile } from "../../shared/api";
import type { LabelPreference } from "@openmail/core/schema";

const account = (id: string, profileId = "work", enabled = true): Account => ({
  id,
  profileId,
  enabled,
  provider: "gmail",
  email: `${id}@example.com`,
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  needsReauth: false,
});
const preference = (accountId: string, id: string, position: number): LabelPreference => ({
  accountId,
  id,
  position,
  favorite: true,
  visible: true,
  color: null,
});
const accounts = [
  account("first"),
  account("second", "personal"),
  account("disabled", "work", false),
];
const labels: Label[] = [{ accountId: "first", id: "Label_1", name: "Projects", color: null }];
const preferences = [
  preference("first", "Label_1", 0),
  preference("first", "mailbox:sent", 1),
  preference("second", "mailbox:inbox", 2),
  preference("disabled", "mailbox:inbox", 3),
  preference("first", "deleted", 4),
];

it("favorite digits follow exactly the visible ordered favorites, including custom and system folders", () => {
  const view = { space: "work", mailbox: "inbox" } as const;
  const favorites = numberedFavorites(view, accounts, labels, preferences);
  expect(favorites.map((f) => f.id)).toEqual(["Label_1", "mailbox:sent"]);
  const firstFavorite = favorites[0];
  if (!firstFavorite) throw new Error("Missing favorite");
  expect(favoriteView(view, firstFavorite)).toEqual({
    space: "work",
    mailbox: "all",
    accountId: undefined,
    label: { accountId: "first", id: "Label_1" },
  });
  const reordered = numberedFavorites(view, accounts, labels, preferences.toReversed());
  const sent = reordered[0];
  if (!sent) throw new Error("Missing favorite");
  expect(favoriteView(view, sent)).toEqual({
    space: "work",
    mailbox: "sent",
    accountId: "first",
    label: undefined,
  });
  expect(
    numberedFavorites(
      { ...view, space: "all", accountId: "second" },
      accounts,
      labels,
      preferences,
    ).map((f) => f.accountId),
  ).toEqual(["first", "first", "second"]);
});

it("favorite digits do not consume typing, profile or system mailbox shortcuts", () => {
  const event = { key: "2", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
  expect(favoriteShortcut(event)).toBe(1);
  expect(favoriteShortcut(event, true)).toBeNull();
  expect(favoriteShortcut({ ...event, repeat: true })).toBeNull();
  expect(favoriteShortcut({ ...event, ctrlKey: true })).toBeNull();
  expect(favoriteShortcut({ ...event, altKey: false })).toBeNull();
  const key = { ...event, altKey: false, ctrlKey: true };
  const first: Profile = { id: "work", name: "Work", icon: "W", color: "blue", position: 0 };
  const second: Profile = { ...first, id: "personal", position: 1 };
  const shortcut = spaceShortcut(key);
  if (shortcut?.kind !== "profile") throw new Error("Missing profile shortcut");
  expect([first, second][shortcut.index]?.id).toBe("personal");
  expect([second, first][shortcut.index]?.id).toBe("work");
});

it("opening system-folder favorites keeps digit assignments stable across accounts in the active space", () => {
  const view = { space: "all", mailbox: "inbox" } as const;
  const before = numberedFavorites(view, accounts, labels, preferences);
  const favorite = before[1];
  if (!favorite) throw new Error("Missing favorite");
  const opened = favoriteView(view, favorite);
  expect(opened.accountId).toBe("first");
  expect(numberedFavorites(opened, accounts, labels, preferences)).toEqual(before);
});
