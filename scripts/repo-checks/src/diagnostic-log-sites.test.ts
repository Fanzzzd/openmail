import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL("./", import.meta.url)), "../../..");
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
  // Use logWarning(code, ...) or logError(code, ...) from packages/core/src/domain/diagnostic-log.ts.
  expect(uncoded).toEqual([]);
});
