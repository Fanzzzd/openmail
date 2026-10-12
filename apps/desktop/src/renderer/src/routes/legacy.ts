import { Schema } from "effect";
import { composeHref, mailHref, threadHref } from "../../../shared/routes";
import { WindowSelection } from "../../../shared/window-state";

/**
 * Windows opened before the router named their screen with `thread`, `single`,
 * `compose` and `selection` query keys. Temporary: main builds hash routes now.
 */
export function legacyHref(search: string): string | null {
  const query = new URLSearchParams(search);
  const thread = query.get("thread");
  if (thread) return threadHref(thread, query.get("single") === "1");
  const compose = query.get("compose");
  if (compose) return composeHref(compose);
  const raw = query.get("selection");
  if (!raw) return null;
  try {
    const { messageId, ...view } = Schema.decodeUnknownSync(WindowSelection)(JSON.parse(raw));
    return mailHref(view, messageId ? { thread: messageId } : {});
  } catch {
    return null;
  }
}
