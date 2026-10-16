/** The lowest layer of the search syntax: words, quoting, dates and folder names. */

import { MAILBOX_LABEL } from "../domain/mailbox-labels.js";

export const SEARCH_FOLDER_LABELS: Readonly<Record<string, string>> = MAILBOX_LABEL;
export const searchWords = (text: string): string[] =>
  text.match(/(?:[^\s"]|"(?:\\.|[^"\\])*(?:"|$))+/g) ?? [];

export function completeQuotes(text: string): boolean {
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) escaped = false;
    else if (character === "\\" && quoted) escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  return !quoted;
}

export const unquoteSearchValue = (text: string) =>
  text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replace(/\\(["\\])/g, "$1") : text;
/** The text a search word looks for: without the `*` that makes it a prefix, and unquoted. */
export const searchTermText = (word: string) =>
  unquoteSearchValue(word.endsWith("*") ? word.slice(0, -1) : word);
export const quoteSearchValue = (text: string): string =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Calendar tokens describe local midnight, including the timezone's DST rules. */
export function parseSearchDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.replaceAll("/", "-"));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date.getTime()
    : null;
}

export const contains = (text: string, term: string) =>
  text.toLocaleLowerCase().includes(term.toLocaleLowerCase());

export function searchFolderValue(value: string): string {
  const key = value.toLowerCase();
  return Object.hasOwn(SEARCH_FOLDER_LABELS, key) ? (SEARCH_FOLDER_LABELS[key] ?? value) : value;
}
