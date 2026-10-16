/** Editing the search field: chips, operator and date pickers, token edits and value suggestions. */

import {
  SEARCH_FOLDER_LABELS,
  completeQuotes,
  parseSearchDate,
  quoteSearchValue,
  searchWords,
  unquoteSearchValue,
} from "./search-tokens.js";
import { hasSearchExpression } from "./search.js";
import type { Address } from "../domain/message.js";
import type { Label } from "../domain/account.js";

/**
 * The final term stays editable until whitespace/Enter finishes it outside quotes.
 * A space typed after plain words stays in `text`, because the field shows `text` as its value.
 */
export function searchFieldParts(value: string): {
  chips: string[];
  text: string;
  pending: string;
} {
  const words = searchWords(value);
  if (hasSearchExpression(value))
    return {
      chips: [],
      text: value,
      pending: /\s$/.test(value) ? "" : (words.at(-1) ?? ""),
    };
  const complete = /\s$/.test(value) && completeQuotes(value);
  const pending = complete ? "" : (words.at(-1) ?? "");
  const finished = pending ? words.slice(0, -1) : words;
  const plain = finished.filter((word) => !word.includes(":"));
  // A finished operator became a chip and took the space with it; a finished word keeps it.
  const spaced = complete && plain.length > 0 && !finished.at(-1)?.includes(":");
  return {
    chips: finished.filter((word) => word.includes(":")),
    text: [...plain, pending].filter(Boolean).join(" ") + (spaced ? " " : ""),
    pending,
  };
}
export function serializeSearchField(chips: readonly string[], text: string): string {
  const value = [...chips, text].filter(Boolean).join(" ");
  return chips.length > 0 && !text ? `${value} ` : value;
}

export function selectSearchOperator(value: string, operator: string): string {
  const { chips, text, pending } = searchFieldParts(value);
  const free = (pending ? text.slice(0, -pending.length) : text).trimEnd();
  const next = [free, operator].filter(Boolean).join(" ");
  return serializeSearchField(chips, operator.endsWith(":") ? next : `${next} `);
}
export function searchCalendarDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** A partly typed native date field must never commit an early year. */
export function selectSearchDate(value: string, operator: string, date: string): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number(date.slice(0, 4)) < 1970 ||
    parseSearchDate(date) === null
  )
    return null;
  return selectSearchOperator(value, `${operator}${date}`);
}

/** A single quoted operator prevents provider-controlled addresses injecting search terms. */
export const senderSearchQuery = (address: string): string => `from:${quoteSearchValue(address)} `;

/** Incomplete quoted values are decoded for lookup, never for query construction. */
export function searchValueTarget(pending: string): { operator: string; value: string } | null {
  const match = /^(-?)(from|to|cc|label|folder|in|before|after):(.*)$/i.exec(pending);
  if (!match) return null;
  const raw = match[3] ?? "";
  return {
    operator: `${match[1]}${match[2]?.toLowerCase()}:`,
    value:
      raw.startsWith('"') && !completeQuotes(raw)
        ? unquoteSearchValue(`${raw}"`)
        : unquoteSearchValue(raw),
  };
}

export function searchValueSuggestions(
  pending: string,
  contacts: readonly Address[],
  labels: readonly Pick<Label, "id" | "name">[],
): { token: string; label: string }[] {
  const target = searchValueTarget(pending);
  if (!target) return [];
  const operator = target.operator.replace(/^-/, "");
  const needle = target.value.toLocaleLowerCase();
  if (["from:", "to:", "cc:"].includes(operator))
    return contacts
      .filter((a) => `${a.name} ${a.address}`.toLocaleLowerCase().includes(needle))
      .slice(0, 10)
      .map((a) => ({
        token: `${target.operator}${quoteSearchValue(a.address)}`,
        label: a.name ? `${a.name} <${a.address}>` : a.address,
      }));
  if (["label:", "folder:", "in:"].includes(operator)) {
    const values = new Map(labels.map((l) => [l.name, l.name]));
    if (operator !== "label:")
      for (const name of Object.keys(SEARCH_FOLDER_LABELS)) values.set(name, name);
    return [...values]
      .filter(([name]) => name.toLocaleLowerCase().includes(needle))
      .slice(0, 10)
      .map(([name, value]) => ({
        token: `${target.operator}${quoteSearchValue(value)}`,
        label: name,
      }));
  }
  return [];
}

export function searchDateSuggestions(
  operator: string,
  now = new Date(),
): { kind: "today" | "yesterday" | "last7Days"; token: string }[] {
  const day = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const date = (offset: number) => new Date(day + offset * 86_400_000).toISOString().slice(0, 10);
  const suggestions: { kind: "today" | "yesterday" | "last7Days"; token: string }[] = [
    { kind: "today", token: `${operator}${date(0)}` },
    { kind: "yesterday", token: `${operator}${date(-1)}` },
    { kind: "last7Days", token: `after:${date(-6)} before:${date(1)}` },
  ];
  return operator.startsWith("-") ? suggestions.slice(0, 2) : suggestions;
}

export function searchTokenModifiers(token: string): string[] {
  const key = token.replace(/^-/, "").split(":")[0];
  if (["from", "to", "cc"].includes(key ?? "")) return ["from", "to", "cc"];
  if (["label", "folder", "in"].includes(key ?? "") && !token.endsWith(":attachment"))
    return ["label", "in", "folder"];
  if (["before", "after"].includes(key ?? "")) return ["before", "after"];
  return [];
}
export function modifySearchToken(token: string, modifier: string): string {
  return `${token.startsWith("-") ? "-" : ""}${modifier}${token.slice(token.indexOf(":"))}`;
}
export const negateSearchToken = (token: string): string =>
  token.startsWith("-") ? token.slice(1) : `-${token}`;
export function editSearchToken(value: string, index: number): string {
  const { chips, text } = searchFieldParts(value);
  const token = chips[index];
  return serializeSearchField(
    chips.filter((_, i) => i !== index),
    [text.trimEnd(), token].filter(Boolean).join(" "),
  );
}
