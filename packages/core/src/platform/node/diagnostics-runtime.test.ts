import { expect, it } from "vitest";
import { diagnosticRecord } from "./diagnostics.js";

it("main-process uncaught errors keep their fixed reason in the diagnostics file", () => {
  for (const reason of ["uncaught-exception", "unhandled-rejection"])
    expect(diagnosticRecord("runtime-error", { reason, message: "secret text" }, 0)).toEqual({
      at: 0,
      event: "runtime-error",
      reason,
    });
});
