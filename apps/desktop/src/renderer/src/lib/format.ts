import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Account } from "../../../shared/api";
import { dateLocale, readDateRegion, type DateRegion } from "../../../shared/date-region";
export { accountName, displayName } from "@openmail/core/schema";

/** The OS region main put in the page query (i18n.ts sets it); the web build has none. */
let SYSTEM_REGION: DateRegion = { region: undefined, hourCycle: undefined };
export function setSystemDateRegion(query: URLSearchParams) {
  SYSTEM_REGION = readDateRegion(query);
}
const browserRegion = () => (typeof navigator === "undefined" ? undefined : navigator.language);

/** Locale and clock for dates shown in the UI language. */
export function dateFormat(i18n: I18n, region: DateRegion = SYSTEM_REGION) {
  const locale = dateLocale(i18n.locale, region.region ?? browserRegion());
  const clock = region.hourCycle ? { hourCycle: region.hourCycle } : {};
  // A 24-hour clock pads the hour (08:09); a 12-hour clock does not (8:09 AM).
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric", ...clock }).resolvedOptions()
    .hourCycle;
  const hour = cycle === "h23" || cycle === "h24" ? "2-digit" : "numeric";
  return {
    locale,
    time: { hour, minute: "2-digit", ...clock } satisfies Intl.DateTimeFormatOptions,
    /** Extra options for a format that includes the time of day. */
    clock,
  };
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** List timestamps: time today, weekday this week, date otherwise. */
export function shortDate(
  ms: number,
  i18n: I18n,
  region: DateRegion = SYSTEM_REGION,
  now = new Date(),
): string {
  const { locale, time } = dateFormat(i18n, region);
  const d = new Date(ms);
  if (sameDay(d, now)) return d.toLocaleTimeString(locale, time);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return i18n._(msg`Yesterday`);
  if (now.getTime() - ms < 6 * 86_400_000)
    return d.toLocaleDateString(locale, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
  return d.toLocaleDateString(locale);
}

/** Account colors. Each is dark enough for white initials at WCAG AA (4.5:1). */
const AVATAR_COLORS = [
  "bg-rose-700",
  "bg-orange-700",
  "bg-amber-700",
  "bg-emerald-700",
  "bg-teal-700",
  "bg-sky-700",
  "bg-indigo-600",
  "bg-violet-600",
  "bg-fuchsia-700",
];

export function avatarColor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export const accountColorValue = (account: Account) =>
  account.color ?? `var(--color-${avatarColor(account.email).slice(3)})`;
export const accountColorClass = (account: Account) =>
  account.color ? "" : avatarColor(account.email);
export const accountColorStyle = (account: Account) =>
  account.color ? { backgroundColor: account.color } : undefined;

export function formatBytes(n: number, locale: string): string {
  const unit =
    n < 1024 ? "byte" : n < 1024 ** 2 ? "kilobyte" : n < 1024 ** 3 ? "megabyte" : "gigabyte";
  const value =
    n < 1024 ? n : n < 1024 ** 2 ? n / 1024 : n < 1024 ** 3 ? n / 1024 ** 2 : n / 1024 ** 3;
  const digits = unit === "megabyte" || unit === "gigabyte" ? 1 : 0;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: unit === "byte" ? "long" : "short",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Thread headers: "Today 18:24", "Yesterday 18:24", "September 21 18:24", or a full date in older years. */
export function threadDate(
  ms: number,
  i18n: I18n,
  region: DateRegion = SYSTEM_REGION,
  now = new Date(),
): string {
  const { locale, time: timeOptions } = dateFormat(i18n, region);
  const d = new Date(ms);
  const time = d.toLocaleTimeString(locale, timeOptions);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return i18n._(msg`Today ${time}`);
  if (sameDay(d, yesterday)) return i18n._(msg`Yesterday ${time}`);
  const day =
    d.getFullYear() === now.getFullYear()
      ? d.toLocaleDateString(locale, { month: "long", day: "numeric" })
      : d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
  return `${day} ${time}`;
}

/**
 * Tailwind classes per profile color key. Literal strings so Tailwind sees them. Each is dark
 * enough for white text at WCAG AA (4.5:1) when the space icon is a letter.
 */
export const PROFILE_BG: Record<string, string> = {
  blue: "bg-blue-700",
  violet: "bg-violet-700",
  rose: "bg-rose-700",
  orange: "bg-orange-700",
  amber: "bg-amber-700",
  emerald: "bg-emerald-700",
  teal: "bg-teal-700",
  slate: "bg-slate-600",
};

/** First grapheme, so a pasted emoji with modifiers stays whole. */
export function firstGrapheme(s: string): string {
  const [first] = new Intl.Segmenter().segment(s.trim());
  return first?.segment ?? "";
}

/** Google Material avatar tones. Gmail's private contact-to-color mapping is not public.
 * NFC + trimmed lowercase display name; UTF-16 polynomial hash (31), unsigned 32 bit.
 * Stable across locales and restarts; email is used only when the name is absent. */
export const GMAIL_AVATAR_TONES = [
  "#c62828",
  "#ad1457",
  "#7b1fa2",
  "#512da8",
  "#303f9f",
  "#3367d6",
  "#1565c0",
  "#00695c",
  "#2e7d32",
  "#a65a00",
  "#bf360c",
  "#6d4c41",
];
export function letterAvatarColor(name: string): string {
  const key = name.normalize("NFC").trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return GMAIL_AVATAR_TONES[hash % GMAIL_AVATAR_TONES.length] ?? "#3367d6";
}

/**
 * A row's preview with preheader padding collapsed to one space. Senders pad
 * the preview with runs of invisible characters (joiners, figure spaces, byte
 * order marks) so clients stop reading there; kept, the padding fills the row
 * with blank space and a lone ellipsis. A single joiner stays: emoji sequences
 * and Persian or Indic text need it.
 */
export function previewText(snippet: string): string {
  return snippet.replace(/(?:[\u00ad\u180e\u200b-\u200d\u2060\s]|\u034f){2,}/g, " ").trim();
}
