import { Effect } from "effect";
import type { IncomingMessage, MailOp, Provider } from "../domain/domain.js";
import { applyOpToLabels } from "../domain/mail-ops.js";

export const WRITE_RECOVERY_WINDOW_MS = 2 * 60_000;

export const cacheIO = <A>(work: () => Promise<A>, fallback: A) =>
  Effect.tryPromise(work).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Attachment cache unavailable", error).pipe(Effect.as(fallback)),
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
