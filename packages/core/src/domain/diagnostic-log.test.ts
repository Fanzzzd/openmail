import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Logger, References } from "effect";
import { expect, it } from "vitest";
import { LOG_CODE_ANNOTATION, logCodeOf, logError, logWarning } from "./diagnostic-log.js";

const repo = resolve(fileURLToPath(new URL("./", import.meta.url)), "../../../..");
const SOURCES = ["packages/core/src", "packages/cli/src", "apps/desktop/src", "apps/mobile/src"];
const UNCODED = /\bEffect\.(?:logWarning|logError|logFatal|logWithLevel)\b/;

it("every warning and error log site attaches a diagnostics code", () => {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SOURCES],
    { cwd: repo, encoding: "utf8" },
  )
    .split("\n")
    .filter(
      (file) =>
        /\.(?:ts|tsx|mts|cts)$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        file !== "packages/core/src/domain/diagnostic-log.ts",
    );
  expect(files.length).toBeGreaterThan(100);
  const uncoded = files.flatMap((file) =>
    readFileSync(resolve(repo, file), "utf8")
      .split("\n")
      .flatMap((line, index) => (UNCODED.test(line) ? [`${file}:${index + 1}`] : [])),
  );
  // Use logWarning(code, ...) or logError(code, ...) from diagnostic-log.ts instead.
  expect(uncoded).toEqual([]);
});

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
