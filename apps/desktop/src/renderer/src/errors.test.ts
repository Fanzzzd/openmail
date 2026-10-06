import { describe, expect, it } from "vitest";

import { PUBLIC_ERROR_MESSAGES } from "../../shared/public-error-messages";
import { INPUT_ERRORS } from "./errors";

describe("input error translations", () => {
  it("only translate messages the main process lets through", () => {
    expect(
      Object.keys(INPUT_ERRORS).filter((message) => !PUBLIC_ERROR_MESSAGES.has(message)),
    ).toEqual([]);
  });
});
