import { Effect } from "effect";
import { logWarning } from "../domain/diagnostic-log.js";
import type { IncomingMessage } from "../domain/message.js";
import type { MailOp } from "../domain/changes.js";
import type { Provider } from "../domain/account.js";
import { applyOpToLabels } from "../domain/mail-ops.js";

export const WRITE_RECOVERY_WINDOW_MS = 2 * 60_000;
/** What restoring or saving a draft the person already discarded fails with. */
export const DISCARDED_DRAFT_MESSAGE = "This draft was already discarded.";

export const cacheIO = <A>(work: () => Promise<A>, fallback: A) =>
  Effect.tryPromise(work).pipe(
    Effect.catch((error) =>
      logWarning("attachment-cache-unavailable", "Attachment cache unavailable", error).pipe(
        Effect.as(fallback),
      ),
    ),
  );

// Merge queued intent without running local-action reminder side effects.
export const withPendingOps = (
  incoming: IncomingMessage,
  ops: readonly MailOp[],
  provider: Provider,
): IncomingMessage => {
  if (!ops.length) return incoming;
  const labels = ops.reduce(
    (current, op) => applyOpToLabels(current, op, provider),
    [...incoming.labels],
  );
  return {
    ...incoming,
    labels,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
  };
};
