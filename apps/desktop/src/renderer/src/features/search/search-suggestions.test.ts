import { expect, it } from "vitest";
import { SEARCH_OPERATORS } from "@openmail/core/schema";
import {
  addRecentSearch,
  parseRecentSearches,
  RECENT_SEARCH_LIMIT,
} from "../../state/recent-searches";
import {
  contactLookup,
  SEARCH_SUGGESTION_LIMIT,
  suggestionKeyAction,
  SUGGESTED_OPERATORS,
  searchSuggestions,
} from "./search-suggestions";

const keys = (groups: ReturnType<typeof searchSuggestions>) =>
  groups.flatMap(({ group, items }) =>
    items.map((item) => `${group}:${item.kind === "token" ? item.token : item.kind}`),
  );

it("suggests only operators the parser knows, and hides the obscure ones", () => {
  for (const { token } of SUGGESTED_OPERATORS) expect(SEARCH_OPERATORS).toContain(token);
  const offered = new Set(SUGGESTED_OPERATORS.map(({ token }) => token));
  for (const hidden of [
    "list:",
    "deliveredto:",
    "header:",
    "has:userlabels",
    "has:nouserlabels",
    "rfc822msgid:",
    "older:",
    "newer:",
    "folder:",
  ])
    expect(offered.has(hidden)).toBe(false);
});

it("an empty field lists recent searches and nothing else", () => {
  const input = { recents: [], contacts: [], labels: [] };
  expect(searchSuggestions({ ...input, value: "" })).toEqual([]);
  expect(searchSuggestions({ ...input, value: "  " })).toEqual([]);
  expect(keys(searchSuggestions({ ...input, value: "", recents: ["a", "b"] }))).toEqual([
    "recent:recent",
    "recent:recent",
    "recent:clearRecent",
  ]);
});

it("typing caps the list and orders filters first only for a filter name", () => {
  const contacts = Array.from({ length: 5 }, (_, i) => ({
    name: `Hasan ${i}`,
    address: `hasan${i}@example.com`,
  }));
  const labels = [
    { id: "1", name: "Hash browns" },
    { id: "2", name: "hash browns" },
    { id: "3", name: "Hashtags" },
  ];
  const groups = searchSuggestions({
    value: "has",
    recents: ["has:pdf invoice", "hash", "has budget", "other"],
    contacts,
    labels,
  });
  expect(groups.map(({ group }) => group)).toEqual(["filters", "recent", "people"]);
  expect(groups.flatMap(({ items }) => items)).toHaveLength(SEARCH_SUGGESTION_LIMIT);
  expect(keys(groups).slice(0, 4)).toEqual([
    "filters:has:attachment",
    "filters:has:pdf",
    "filters:has:image",
    "filters:has:document",
  ]);
  const plain = searchSuggestions({ value: "hash", recents: [], contacts, labels });
  expect(keys(plain)).toEqual([
    'people:from:"hasan0@example.com"',
    'people:to:"hasan0@example.com"',
    'people:from:"hasan1@example.com"',
    'people:to:"hasan1@example.com"',
    'labels:label:"Hash browns"',
    'labels:label:"Hashtags"',
  ]);
  expect(searchSuggestions({ value: "x", recents: [], contacts, labels })).toEqual([]);
  // Two letters are too short to look people up.
  expect(keys(searchSuggestions({ value: "ha", recents: [], contacts, labels }))).not.toContain(
    'people:from:"hasan0@example.com"',
  );
  // Obscure operators still parse when typed but are never offered.
  for (const value of ["rfc", "deliveredto", "header", "has:user", "older:", "list", "-has:p"])
    expect(keys(searchSuggestions({ value, recents: [], contacts: [], labels: [] }))).toEqual(
      value === "-has:p" ? ["filters:-has:pdf", "filters:-has:presentation"] : [],
    );
});

it("keys: Enter runs the search, Tab completes, Delete removes a recent search", () => {
  const filter = searchSuggestions({ value: "has:pd", recents: [], contacts: [], labels: [] });
  const only = filter[0]?.items[0];
  expect(suggestionKeyAction({ key: "Enter", shiftKey: false }, undefined, filter)).toEqual({
    kind: "submit",
  });
  expect(suggestionKeyAction({ key: "Enter", shiftKey: false }, only, filter)).toBeNull();
  expect(suggestionKeyAction({ key: "Tab", shiftKey: false }, undefined, filter)).toEqual({
    kind: "complete",
    suggestion: only,
  });
  expect(suggestionKeyAction({ key: "Tab", shiftKey: true }, undefined, filter)).toBeNull();
  const recent = { kind: "recent" as const, key: "\u0000recent:q", query: "q" };
  expect(suggestionKeyAction({ key: "Delete", shiftKey: false }, recent, [])).toEqual({
    kind: "remove",
    query: "q",
  });
  expect(suggestionKeyAction({ key: "Backspace", shiftKey: false }, recent, [])).toBeNull();
  expect(contactLookup("al")).toBe("");
  expect(contactLookup("-ali")).toBe("ali");
  expect(contactLookup("from:al")).toBe("al");
  expect(contactLookup("label:ali")).toBe("");
});

it("recent searches are trimmed, deduplicated, newest first and bounded", () => {
  let list: string[] = [];
  for (let i = 0; i < 12; i++) list = addRecentSearch(list, ` query  ${i} `);
  expect(list).toHaveLength(RECENT_SEARCH_LIMIT);
  expect(list[0]).toBe("query 11");
  expect(addRecentSearch(list, "QUERY 5")[0]).toBe("QUERY 5");
  expect(addRecentSearch(list, "QUERY 5").filter((q) => /query 5/i.test(q))).toHaveLength(1);
  expect(addRecentSearch(["a"], "  ")).toEqual(["a"]);
  expect(parseRecentSearches('["a", 3, "", null, "b"]')).toEqual(["a", "b"]);
  expect(parseRecentSearches("{")).toEqual([]);
  expect(parseRecentSearches('{"a":1}')).toEqual([]);
});
