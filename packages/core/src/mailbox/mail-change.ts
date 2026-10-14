import { Effect } from "effect";
import type { MailOp } from "../domain/changes.js";
import type { Actor, Command } from "../domain/command.js";
import { InvalidInput } from "../domain/errors.js";
import type { Store } from "../store/service.js";
import { decide } from "./policy.js";

/** The person in the app. Members that take no Actor act as this one. */
export const APP_USER: Actor = { kind: "user", surface: "app" };

/**
 * The policy check for members that change mail without a proposal step, such as the batch
 * path with undo. It runs the same `decide` as `perform` and fails unless the change applies.
 */
export const requireApplied = (command: Command, actor: Actor) => {
  const decision = decide(command, actor, "off");
  return decision.status === "applied"
    ? Effect.void
    : Effect.fail(
        new InvalidInput({
          message: decision.status === "denied" ? decision.reason : "This change needs approval.",
        }),
      );
};

/**
 * Applies one MailOp to a local message, queues it for the provider and writes its audit row.
 * `perform` and the batch path with undo both change mail through here. A copy gets one queue
 * entry per destination, so a later failure does not repeat earlier copies.
 */
export const applyMailOp = (
  store: Store["Service"],
  actor: Actor,
  target: { readonly id: string; readonly accountId: string; readonly providerId: string },
  op: MailOp,
) =>
  Effect.gen(function* () {
    yield* store.applyLocalOp(target.id, op);
    if (op.kind === "copy")
      for (const labelId of new Set(op.labelIds))
        yield* store.enqueueOp(target.accountId, target.providerId, {
          kind: "copy",
          labelIds: [labelId],
        });
    else yield* store.enqueueOp(target.accountId, target.providerId, op);
    yield* store.appendAudit({
      actor,
      accountId: target.accountId,
      action: op.kind,
      detail: { id: target.id, op },
    });
  });
