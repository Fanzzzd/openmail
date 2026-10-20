import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  type Address,
  type Label,
  quoteSearchValue,
  searchFieldParts,
  searchValueSuggestions,
  searchValueTarget,
} from "@openmail/core/schema";
import type { KeyEvent } from "../../../../shared/shortcuts";
import { removesSuggestion } from "../../lib/delete-key";

/** Filters worth suggesting. Every other operator still works when typed. */
export const SUGGESTED_OPERATORS: readonly { token: string; description: MessageDescriptor }[] = [
  { token: "from:", description: msg`Messages from a person` },
  { token: "to:", description: msg`Messages sent to a person` },
  { token: "cc:", description: msg`Messages copied to a person` },
  { token: "subject:", description: msg`Words in the subject` },
  { token: "has:attachment", description: msg`Messages with attachments` },
  { token: "has:pdf", description: msg`Messages with a PDF attachment` },
  { token: "has:image", description: msg`Messages with an image attachment` },
  { token: "has:document", description: msg`Messages with a document attachment` },
  { token: "has:spreadsheet", description: msg`Messages with a spreadsheet attachment` },
  { token: "has:presentation", description: msg`Messages with a presentation attachment` },
  { token: "filename:", description: msg`Attachment file name` },
  { token: "in:attachment", description: msg`Only text inside attachments` },
  { token: "is:unread", description: msg`Unread messages` },
  { token: "is:starred", description: msg`Starred messages` },
  { token: "is:important", description: msg`Important messages` },
  { token: "label:", description: msg`Messages with a label` },
  { token: "in:", description: msg`Messages in a folder` },
  { token: "before:", description: msg`Messages before a date` },
  { token: "after:", description: msg`Messages after a date` },
  { token: "newer_than:", description: msg`Messages newer than a period, such as 7d` },
  { token: "older_than:", description: msg`Messages older than a period, such as 1y` },
  { token: "larger:", description: msg`Messages larger than a size, such as 5M` },
  { token: "smaller:", description: msg`Messages smaller than a size, such as 1M` },
];

export const SEARCH_SUGGESTION_LIMIT = 8;
/** A typed word looks up people from this many characters; shorter prefixes match too much. */
const PEOPLE_LOOKUP_MIN = 3;
/** Recent searches stay inside the combobox values, apart from search tokens. */
const RECENT = "\u0000recent:";
const CLEAR_RECENT = "\u0000clear-recent";
const isRecentKey = (key: string) => key.startsWith("\u0000");

export type SearchSuggestionGroup = "recent" | "people" | "labels" | "filters" | "dates";
export type SearchSuggestion =
  | { kind: "recent"; key: string; query: string }
  | { kind: "clearRecent"; key: string }
  | {
      kind: "token";
      key: string;
      /** Inserted in place of the word being typed. */
      token: string;
      label: string;
      detail?: string;
      description?: MessageDescriptor;
    };

const recentKey = (query: string) => `${RECENT}${query}`;
const token = (item: { token: string; label: string; detail?: string }): SearchSuggestion => ({
  kind: "token",
  key: item.token,
  ...item,
});

/** Which group a filter value's suggestions belong to. */
export function operatorGroup(operator: string): SearchSuggestionGroup {
  const name = operator.replace(/^-/, "");
  if (["from:", "to:", "cc:"].includes(name)) return "people";
  if (["before:", "after:"].includes(name)) return "dates";
  return "labels";
}

/** The text to look people up by: a from:, to: or cc: value, or a typed word. */
export function contactLookup(pending: string): string {
  const target = searchValueTarget(pending);
  if (target) return operatorGroup(target.operator) === "people" ? target.value.trim() : "";
  const word = pending.includes(":") ? "" : pending.replace(/^-/, "");
  return word.length >= PEOPLE_LOOKUP_MIN ? word : "";
}

/** The suggestion for a picked value; a token picked outside the list, such as a date, as typed. */
export function suggestionFor(
  byKey: ReadonlyMap<string, SearchSuggestion>,
  key: string,
): SearchSuggestion | undefined {
  return (
    byKey.get(key) ??
    (isRecentKey(key) ? undefined : { kind: "token", key, token: key, label: key })
  );
}

/**
 * What a key does in the field. Enter without a highlighted row runs the
 * search. Tab completes the highlighted row, or the only filter that fits.
 * Forward Delete removes a highlighted recent search, by the same rule as a
 * recipient suggestion (removesSuggestion); Backspace always edits the text.
 */
export function suggestionKeyAction(
  event: KeyEvent,
  field: Parameters<typeof removesSuggestion>[1],
  active: SearchSuggestion | undefined,
  groups: readonly { group: SearchSuggestionGroup; items: readonly SearchSuggestion[] }[],
):
  | { kind: "submit" }
  | { kind: "complete"; suggestion: SearchSuggestion }
  | { kind: "remove"; query: string }
  | null {
  if (event.key === "Enter") return active ? null : { kind: "submit" };
  if (event.key === "Tab" && !event.shiftKey) {
    const [only] = groups.length === 1 && groups[0]?.group === "filters" ? groups[0].items : [];
    const completion = active ?? (groups[0]?.items.length === 1 ? only : undefined);
    return completion?.kind === "token" ? { kind: "complete", suggestion: completion } : null;
  }
  if (active?.kind === "recent" && removesSuggestion(event, field))
    return { kind: "remove", query: active.query };
  return null;
}

/**
 * What the search field offers, in groups of at most `SEARCH_SUGGESTION_LIMIT`
 * rows overall. An empty field offers recent searches only. Typing offers
 * matching recent searches, people, labels, and filters whose name starts
 * with the typed text. A filter's value offers its people, labels or dates.
 */
export function searchSuggestions({
  value,
  recents,
  contacts,
  labels,
  dates = [],
}: {
  value: string;
  recents: readonly string[];
  /** People matching the word being typed, or the value of from:, to: or cc:. */
  contacts: readonly Address[];
  labels: readonly Pick<Label, "id" | "name">[];
  /** Date presets for a before: or after: value, already labelled. */
  dates?: readonly { token: string; label: string }[];
}): { group: SearchSuggestionGroup; items: SearchSuggestion[] }[] {
  const { chips, pending } = searchFieldParts(value);
  const fresh = (items: SearchSuggestion[]) =>
    items.filter((item) => item.kind !== "token" || !chips.includes(item.token));
  if (!value.trim())
    return recents.length
      ? [
          {
            group: "recent",
            items: [
              ...recents.map((query): SearchSuggestion => ({
                kind: "recent",
                key: recentKey(query),
                query,
              })),
              { kind: "clearRecent", key: CLEAR_RECENT },
            ],
          },
        ]
      : [];
  if (!pending) return [];
  const target = searchValueTarget(pending);
  if (target) {
    const group = operatorGroup(target.operator);
    const items = fresh([
      ...searchValueSuggestions(pending, contacts, labels).map(token),
      ...dates.map(token),
    ]).slice(0, SEARCH_SUGGESTION_LIMIT);
    return items.length ? [{ group, items }] : [];
  }
  const negated = pending.startsWith("-") ? "-" : "";
  const word = pending.slice(negated.length).toLocaleLowerCase();
  const typed = value.trim().toLocaleLowerCase();
  const filters = fresh(
    word.length >= 2 || word.includes(":")
      ? SUGGESTED_OPERATORS.filter(
          (item) => item.token.startsWith(word) && item.token !== word,
        ).map((item) => ({
          kind: "token",
          key: `${negated}${item.token}`,
          token: `${negated}${item.token}`,
          label: `${negated}${item.token}`,
          description: item.description,
        }))
      : [],
  ).slice(0, 4);
  const recent = recents
    .filter((query) => query.toLocaleLowerCase().includes(typed) && query.trim() !== value.trim())
    .slice(0, 2)
    .map((query): SearchSuggestion => ({ kind: "recent", key: recentKey(query), query }));
  const people = fresh(
    word.length >= PEOPLE_LOOKUP_MIN && !word.includes(":")
      ? contacts.slice(0, 2).flatMap((person) =>
          ["from:", "to:"].map((operator) =>
            token({
              token: `${negated}${operator}${quoteSearchValue(person.address)}`,
              label: person.name || person.address,
              detail: `${negated}${operator} ${person.address}`,
            }),
          ),
        )
      : [],
  );
  const named = new Set<string>();
  const labelItems = fresh(
    word.length >= 2 && !word.includes(":")
      ? labels
          .filter((label) => {
            const name = label.name.toLocaleLowerCase();
            if (named.has(name) || !name.includes(word)) return false;
            named.add(name);
            return true;
          })
          .slice(0, 2)
          .map((label) =>
            token({
              token: `${negated}label:${quoteSearchValue(label.name)}`,
              label: label.name,
              detail: `${negated}label:`,
            }),
          )
      : [],
  );
  const groups: { group: SearchSuggestionGroup; items: SearchSuggestion[] }[] = [
    { group: "recent", items: recent },
    { group: "people", items: people },
    { group: "labels", items: labelItems },
  ];
  // Typing a filter's name puts filters first; otherwise they follow people and labels.
  if (filters.length) groups.unshift({ group: "filters", items: filters });
  else groups.push({ group: "filters", items: filters });
  let room = SEARCH_SUGGESTION_LIMIT;
  return groups.flatMap(({ group, items }) => {
    const kept = items.slice(0, room);
    room -= kept.length;
    return kept.length ? [{ group, items: kept }] : [];
  });
}
