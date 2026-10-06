import { cleanDisplayName } from "./message-security.js";
import { messageModelText } from "./visible-text.js";
import type { Address, Message } from "./domain.js";
import type { ModelThread } from "./mailbox.js";

const QUOTE_MARKERS = [
  /^On .{4,200} wrote:\s*$/i,
  /^.{0,200}写道[:：]\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*原始邮件\s*-{2,}\s*$/,
];
const FROM_HEADER = /^(?:From|发件人)[:：]\s*.+$/i;
function replyHeader(lines: readonly string[], index: number, quoteBoundary: boolean): boolean {
  const line = lines[index]?.trim() ?? "";
  if (QUOTE_MARKERS.some((pattern) => pattern.test(line))) return true;
  if (!FROM_HEADER.test(line)) return false;
  if (quoteBoundary) return true;
  const headers = lines.slice(index + 1, index + 8).map((value) => value.trim());
  return (
    headers.some((value) => /^(?:Sent|Date|发送时间|日期)[:：]/i.test(value)) &&
    headers.some((value) => /^(?:To|收件人)[:：]/i.test(value)) &&
    headers.some((value) => /^(?:Subject|主题)[:：]/i.test(value))
  );
}
function authorLines(lines: readonly string[], quoteBoundary: boolean): string {
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === "-- " || replyHeader(lines, index, quoteBoundary)) break;
    if (!line.startsWith(">")) out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const who = (a: Address) => (a.name ? `${cleanDisplayName(a.name)} <${a.address}>` : a.address);

/**
 * A thread as plain text within `maxChars` of bodies. Newer messages get
 * their text first: when the budget runs out, the oldest bodies are cut, and
 * `truncated` says how many characters were dropped.
 */
export function toModelThread(messages: readonly Message[], maxChars: number): ModelThread {
  // Long threads can repeat the same body. Reuse extraction only within this
  // view and key both alternatives, since plain-differs depends on bodyText.
  const extracted = new Map<string, Map<string, ReturnType<typeof messageModelText>>>();
  const bodies = messages.map((m) => {
    const alternatives = extracted.get(m.bodyHtml);
    const cached = alternatives?.get(m.bodyText);
    if (cached) return cached;
    const body = messageModelText(m.bodyText, m.bodyHtml);
    if (alternatives) alternatives.set(m.bodyText, body);
    else extracted.set(m.bodyHtml, new Map([[m.bodyText, body]]));
    return body;
  });
  const quoteInfo = bodies.map((body, i) => {
    const message = messages[i];
    const hasReply = message?.headers?.some(
      (h) => h.name.toLowerCase() === "in-reply-to" && h.value.trim(),
    );
    const lines = body.text.replace(/\r\n/g, "\n").split("\n");
    const quotedLines = lines.filter((line) => line.startsWith(">"));
    const quoted = quotedLines
      .map((line) => line.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
    const matching =
      quoted.length > 0 && bodies.slice(0, i).some((previous) => previous.text.includes(quoted));
    const boundary =
      hasReply || matching || lines.some((_line, index) => replyHeader(lines, index, false));
    const text = authorLines(lines, boundary);
    const removed = boundary ? 0 : quotedLines.reduce((sum, line) => sum + line.length, 0);
    return { text, removed };
  });
  const texts = quoteInfo.map((q) => q.text);
  let budget = maxChars;
  let truncated = 0;
  const kept = texts.toReversed().map((text) => {
    const take = Math.max(0, Math.min(text.length, budget));
    budget -= take;
    truncated += text.length - take;
    return take < text.length ? `${text.slice(0, take)}…` : text;
  });
  kept.reverse();

  const last = messages.at(-1);
  return {
    threadId: last?.threadId ?? "",
    accountId: last?.accountId ?? "",
    subject: last?.subject ?? "",
    labels: [...new Set(messages.flatMap((m) => m.labels))],
    messages: messages.map((m, i) => ({
      id: m.id,
      from: who(m.from),
      to: m.to.map(who),
      cc: m.cc.map(who),
      date: new Date(m.date).toISOString(),
      text: kept[i] ?? "",
      ...(bodies[i]?.flags.length || quoteInfo[i]?.removed
        ? {
            flags: [
              ...(bodies[i]?.flags ?? []),
              ...(quoteInfo[i]?.removed ? ["quoted-text-removed" as const] : []),
            ],
          }
        : {}),
      ...(quoteInfo[i]?.removed ? { quotedTextRemoved: quoteInfo[i].removed } : {}),
      attachments: m.attachments.map((a) => a.filename),
    })),
    truncated,
  };
}

/** Byte budget includes headers, ids and JSON escaping, conservatively bounding tokens. */
export function modelContext(messages: readonly Message[], tokenBudget = 6000): ModelThread {
  const bytes = Math.max(256, Math.min(tokenBudget, Number.MAX_SAFE_INTEGER));
  let view = toModelThread(messages, bytes);
  view = { ...view, labels: [], messages: view.messages.map((m) => ({ ...m, attachments: [] })) };
  while (
    new TextEncoder().encode(JSON.stringify(view)).length > bytes &&
    view.messages.length > 0
  ) {
    const first = view.messages[0];
    if (!first) break;
    if (first.text.length > 0) {
      const cut = Math.max(1, Math.ceil(first.text.length / 2));
      view = {
        ...view,
        truncated: view.truncated + cut,
        messages: [{ ...first, text: first.text.slice(0, -cut) }, ...view.messages.slice(1)],
      };
    } else view = { ...view, messages: view.messages.slice(1) };
  }
  return view;
}
