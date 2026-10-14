import { Effect, Logger, References } from "effect";
import { expect, it } from "vitest";
import { LOG_CODE_ANNOTATION, logCodeOf, logError, logWarning } from "./diagnostic-log.js";

// scripts/repo-checks/src/diagnostic-log-sites.test.ts checks that every log site passes a code.
it("the helpers attach the code as an annotation that logCodeOf reads back", () => {
  const seen: unknown[] = [];
  const logger = Logger.make((options) => {
    seen.push(logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations)));
  });
  Effect.runSync(
    Effect.gen(function* () {
      yield* logWarning("snooze-wake-failed", "snooze wake failed");
      yield* logError("system-refresh-failed", "periodic system refresh failed");
      yield* Effect.logWarning("no code");
    }).pipe(Effect.provide(Logger.layer([logger]))),
  );
  expect(seen).toEqual(["snooze-wake-failed", "system-refresh-failed", undefined]);
});

it("only a known code is read from the annotation", () => {
  expect(logCodeOf({ [LOG_CODE_ANNOTATION]: "flush-failed" })).toBe("flush-failed");
  expect(logCodeOf({ [LOG_CODE_ANNOTATION]: "alice@example.com" })).toBeUndefined();
  expect(logCodeOf(Object.create({ [LOG_CODE_ANNOTATION]: "flush-failed" }))).toBeUndefined();
  expect(logCodeOf(null)).toBeUndefined();
});
