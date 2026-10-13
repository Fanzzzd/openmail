import { Effect } from "effect";
import type { DraftPush } from "../../services.js";
import type { DraftCreateState } from "../../domain/domain.js";

/** An isolated journal for provider tests that do not assemble the Store. */
export function draftCreation(): DraftPush["creation"] {
  let state: DraftCreateState = { messageId: "<draft@example.test>", attempted: false };
  return {
    begin: () => Effect.succeed(state),
    attempted: (messageId, attempted = true) =>
      Effect.sync(() => {
        state = { messageId, attempted };
      }),
    missing: () => Effect.succeed(false),
    remember: () => Effect.void,
  };
}
