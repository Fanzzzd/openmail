import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { REMOVE_NEEDS_YES, confirmRemoval } from "./commands/accounts.js";

/** Runs the decision with a stand-in for the y/N question; `asked` counts the questions. */
function decide(yes: boolean, interactive: boolean, answer: boolean) {
  let asked = 0;
  const message = Effect.runSync(
    confirmRemoval(
      yes,
      interactive,
      Effect.sync(() => {
        asked++;
        return answer;
      }),
    ).pipe(Effect.match({ onFailure: (failed) => failed.message, onSuccess: () => null })),
  );
  return { removes: message === null, asked, message };
}

describe("accounts remove asks first", () => {
  it("--yes removes without asking, on a terminal or not", () => {
    expect(decide(true, true, false)).toEqual({ removes: true, asked: 0, message: null });
    expect(decide(true, false, false)).toEqual({ removes: true, asked: 0, message: null });
  });

  it("on a terminal, removes only after a yes", () => {
    expect(decide(false, true, true)).toEqual({ removes: true, asked: 1, message: null });
    expect(decide(false, true, false)).toEqual({
      removes: false,
      asked: 1,
      message: "Canceled. Nothing was removed.",
    });
  });

  it("without a terminal and --yes, refuses without asking", () => {
    expect(decide(false, false, true)).toEqual({
      removes: false,
      asked: 0,
      message: REMOVE_NEEDS_YES,
    });
  });
});
