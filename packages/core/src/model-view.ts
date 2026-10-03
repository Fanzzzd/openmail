import { cleanDisplayName } from "./message-security.js";
import { messageModelText } from "./visible-text.js";
import type { Address, Message } from "./domain.js";
import type { ModelThread } from "./mailbox.js";

// Lines that start the quoted history a reply carries along. Everything from
// the first match on is the earlier thread, which the model already sees as
// separate messages.
const QUOTE_HEADERS = [
  /^On .{4,200} wrote:\s*$/,
  /^.{0,200}写道[:：]\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*原始邮件\s*-{2,}\s*$/,
  /^From: .+$/,
  /^发件人[:：].+$/,
];

/**
 * The part of a message body its author wrote: quoted history (">" lines and
 * everything after a reply header) and the "-- " signature are cut.
 */
export function ownText(body: string): string {
  const out: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "-- " || QUOTE_HEADERS.some((re) => re.test(line.trim()))) break;
    if (line.startsWith(">")) continue;
    out.push(line);
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
  const bodies = messages.map((m) => messageModelText(m.bodyText, m.bodyHtml));
  const texts = bodies.map((body) => ownText(body.text));
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
      ...(bodies[i]?.flags.length ? { flags: bodies[i].flags } : {}),
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
