import { describe, expect, it } from "vitest";
import { explainError, stderrText } from "./cli-errors.js";

/** A stand-in for core's NotFound: the tag and the optional `what` and `id` fields. */
const notFound = (fields: { what?: string; id?: string } = {}) =>
  Object.assign(new Error("Not found."), { _tag: "NotFound", ...fields });

describe("explainError for NotFound", () => {
  it("prints the hint for a known kind", () => {
    const text = stderrText(explainError(notFound({ what: "account", id: "a1" }), undefined));
    expect(text).toBe(
      "error: No account with id a1.\nhint: Run `openmail accounts list` to see them.",
    );
  });

  it("prints only the error line when the kind is unmapped or missing", () => {
    for (const error of [notFound({ what: "widget", id: "w1" }), notFound()]) {
      const text = stderrText(explainError(error, undefined));
      expect(text).not.toContain("hint:");
      expect(text.split("\n")).toHaveLength(1);
    }
  });
});
