import { useState } from "react";
import type { Message } from "../../../../shared/api";

export interface ReaderSelection {
  threadKey: string;
  id: string;
}

/** Conversation identity survives replacement of its representative list message. */
export const readerThreadKey = (row: Pick<Message, "accountId" | "threadId"> | undefined) =>
  row ? JSON.stringify([row.accountId, row.threadId]) : null;

export function replyTarget(
  selection: ReaderSelection | null,
  anchor: string | null,
  grouping: boolean,
  threadKey: string | null,
): string | null {
  return grouping && threadKey !== null && selection?.threadKey === threadKey
    ? selection.id
    : anchor;
}

export function readerMessageId(
  messages: readonly Pick<Message, "id">[],
  chosen: string,
  anchor: string,
  single: boolean,
): string {
  if (single) return anchor;
  if (messages.some((message) => message.id === chosen)) return chosen;
  return messages.some((message) => message.id === anchor)
    ? anchor
    : (messages.at(-1)?.id ?? anchor);
}

/** Keep the mounted view while a new representative's query loads for the same conversation. */
export function useReaderMessages(
  threadKey: string | null,
  loaded: readonly Message[] | undefined,
  unavailable = false,
) {
  const [cache, setCache] = useState({ threadKey, messages: loaded });
  const messages = unavailable ? undefined : loaded;
  if (
    cache.threadKey !== threadKey ||
    (unavailable && cache.messages !== undefined) ||
    (messages && cache.messages !== messages)
  ) {
    setCache({ threadKey, messages });
    return messages;
  }
  return unavailable ? messages : (messages ?? cache.messages);
}

/** A missing selected message must never silently redirect a reply to its sibling. */
export const replySource = (messages: readonly Message[], id: string) =>
  messages.find((message) => message.id === id);
