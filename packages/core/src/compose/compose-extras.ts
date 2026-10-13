import type { Address, InlineImageSize, OutgoingAttachment } from "../domain/domain.js";
import { escapeComposeText } from "./compose-body.js";

export const INLINE_IMAGE_WIDTHS = {
  small: 160,
  medium: 320,
  large: 640,
  original: null,
} satisfies Record<InlineImageSize, number | null>;
export function inlineImageHtml(file: OutgoingAttachment, size: InlineImageSize): string {
  if (!file.contentId) return "";
  const width = INLINE_IMAGE_WIDTHS[size];
  return `<img src="cid:${escapeComposeText(file.contentId)}" alt="${escapeComposeText(file.filename)}"${width === null ? "" : ` width="${width}"`}>`;
}

export function mentionQuery(textBeforeCaret: string): { query: string; length: number } | null {
  const match = /(?:^|\s)[@+]([^\s@+]{1,60})$/.exec(textBeforeCaret);
  return match?.[1] ? { query: match[1], length: match[1].length + 1 } : null;
}
export function mentionHtml(person: Address, id?: string): string {
  return `<a href="mailto:${escapeComposeText(person.address)}"${id && /^[a-f0-9-]{36}$/.test(id) ? ` data-compose-mention="${id}"` : ""}>${escapeComposeText(person.name || person.address)}</a> `;
}

/** Fresh ownership is surrendered when recipients are edited manually. Existing To/Cc/Bcc never belong to a mention. */
export function reconcileMentionRecipients(
  to: readonly Address[],
  other: readonly Address[],
  mentions: readonly Address[],
  fresh: ReadonlySet<string>,
): { to: Address[]; fresh: Set<string> } {
  const active = new Set(mentions.map((person) => person.address.toLowerCase()));
  const recipients = to.filter(
    (person) =>
      !fresh.has(person.address.toLowerCase()) || active.has(person.address.toLowerCase()),
  );
  const owned = new Set([...fresh].filter((address) => active.has(address)));
  const have = new Set([...recipients, ...other].map((person) => person.address.toLowerCase()));
  for (const person of mentions) {
    const key = person.address.toLowerCase();
    if (have.has(key)) continue;
    recipients.push(person);
    have.add(key);
    owned.add(key);
  }
  return { to: recipients, fresh: owned };
}

const emoji = new Map([
  [":)", "🙂"],
  [":-)", "🙂"],
  [":(", "🙁"],
  [":-(", "🙁"],
  [":D", "😃"],
  [";)", "😉"],
  [":+1:", "👍"],
  [":heart:", "❤️"],
  [":smile:", "😄"],
]);
/** Replace a completed token at the caret, not substrings of URLs or addresses. */
export function emojiAtCaret(
  text: string,
  markdown = false,
): { start: number; end: number; replacement: string } | null {
  const match = /(?:^|\s)(:\+1:|:heart:|:smile:|:-?\)|:-?\(|:D|;\))([\s\u00a0])$/.exec(text);
  const token = match?.[1];
  const replacement = token ? emoji.get(token) : undefined;
  if (!replacement || !token || (markdown && markdownCodeAtCaret(text))) return null;
  return { start: text.length - token.length - 1, end: text.length - 1, replacement };
}

function markdownCodeAtCaret(text: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  let ticks = 0;
  for (const line of text.split("\n")) {
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        boundary?.[1]?.charAt(0) === fence.marker &&
        boundary[1].length >= fence.length &&
        !boundary[2]?.trim()
      )
        fence = null;
      continue;
    }
    if (boundary?.[1] && (boundary[1].charAt(0) !== "`" || !boundary[2]?.includes("`"))) {
      fence = { marker: boundary[1].charAt(0), length: boundary[1].length };
      ticks = 0;
      continue;
    }
    if (!line.trim()) ticks = 0;
    for (let index = 0; index < line.length; index++) {
      if (line.charAt(index) !== "`") continue;
      let escapes = 0;
      for (let previous = index - 1; previous >= 0 && line.charAt(previous) === "\\"; previous--)
        escapes++;
      if (!ticks && escapes % 2 === 1) continue;
      let end = index + 1;
      while (line.charAt(end) === "`") end++;
      const length = end - index;
      if (!ticks) ticks = length;
      else if (length === ticks) ticks = 0;
      index = end - 1;
    }
  }
  return fence !== null || ticks !== 0;
}
