import { Effect } from "effect";
import type { StoredDraft } from "../../shared/api";
import type { AppError } from "./errors";
import { needsClosePrompt, type Draft } from "./draft";

/** Ordinary close can only retain a draft or ask; deletion requires a separate user action. */
export function requestDraftClose<R>(options: {
  draft: Draft;
  initial: Draft;
  empty: boolean;
  lookup: Effect.Effect<StoredDraft | null, AppError, R>;
}) {
  return options.lookup.pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(null)),
    Effect.map((stored): "close" | "prompt" =>
      needsClosePrompt(options.draft, stored, {
        initial: options.initial,
        empty: options.empty,
      })
        ? "prompt"
        : "close",
    ),
  );
}
