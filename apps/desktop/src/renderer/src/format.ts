import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
export { displayName } from "@openmail/core/schema";

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** List timestamps: time today, weekday this week, date otherwise. */
export function shortDate(ms: number, i18n: I18n): string {
  const locale = i18n.locale;
  const d = new Date(ms);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return i18n._(msg`Yesterday`);
  if (now.getTime() - ms < 6 * 86_400_000)
    return d.toLocaleDateString(locale, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
  return d.toLocaleDateString(locale);
}

const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
];

export function avatarColor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Thread headers: "Today 18:24", "Yesterday 18:24", "September 21 18:24", or a full date in older years. */
export function threadDate(ms: number, i18n: I18n): string {
  const locale = i18n.locale;
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
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

/** Tailwind classes per profile color key. Literal strings so Tailwind sees them. */
export const PROFILE_BG: Record<string, string> = {
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  rose: "bg-rose-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  slate: "bg-slate-500",
};

/** First grapheme, so a pasted emoji with modifiers stays whole. */
export function firstGrapheme(s: string): string {
  const [first] = new Intl.Segmenter().segment(s.trim());
  return first?.segment ?? "";
}
