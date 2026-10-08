import { InvalidInput, type Prefs } from "@openmail/core/schema";
import { Effect } from "effect";

/** The renderer can reset the attachment save folder but never name one.
 * Only the main-process folder picker stores a custom path. */
export const rendererPrefs = (
  patch: Partial<Prefs>,
): Effect.Effect<Partial<Prefs>, InvalidInput> =>
  patch.attachmentSaveFolder?.kind === "custom"
    ? Effect.fail(new InvalidInput({ message: "Choose the attachment folder in Settings." }))
    : Effect.succeed(patch);
