import { Effect, Logger, References } from "effect";
import { expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { logSyncFailed } from "../sync/sync-failure.js";
import {
  DiagnosticHashKey,
  diagnosticHashes,
  keyedDiagnosticHash,
  LOG_CODE_ANNOTATION,
  logCodeOf,
  logError,
  logWarning,
} from "./diagnostic-log.js";

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

const ACCOUNT = "gmail:Alex@Example.com";
const KEY = "a".repeat(64);
const sha16 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

// The CLI and MCP printed the unkeyed SHA-256 prefix of the account ID on stderr, which anyone
// can recompute from a guessed address.
it("log hashes are keyed with DiagnosticHashKey, and absent without a key", () => {
  const hashes = (key?: string) =>
    Effect.runSync(
      diagnosticHashes({ account: ACCOUNT, folder: "INBOX" }).pipe(
        Effect.provideService(DiagnosticHashKey, () => key),
      ),
    );
  expect(hashes()).toEqual({});
  expect(Effect.runSync(diagnosticHashes({ account: ACCOUNT }))).toEqual({});
  const keyed = hashes(KEY);
  // The same HMAC the diagnostics file always used, so hashes older builds wrote still match.
  expect(keyed).toEqual({
    accountHash: createHmac("sha256", KEY)
      .update(`account:${sha16(ACCOUNT.toLowerCase())}`)
      .digest("hex")
      .slice(0, 16),
    folderHash: createHmac("sha256", KEY)
      .update(`folder:${sha16("INBOX")}`)
      .digest("hex")
      .slice(0, 16),
  });
  expect(keyed.accountHash).toBe(keyedDiagnosticHash(KEY, "account", ACCOUNT.toLowerCase()));
  expect(hashes("b".repeat(64)).accountHash).not.toBe(keyed.accountHash);
  expect(Object.values(keyed)).not.toContain(sha16(ACCOUNT.toLowerCase()));
});

it("a log site prints no account hash without a key, and only the keyed one with it", () => {
  const printed = (key?: string) => {
    const lines: string[] = [];
    const logger = Logger.make((options) => lines.push(JSON.stringify(options.message)));
    Effect.runSync(
      logSyncFailed({ id: ACCOUNT, provider: "gmail" }, "full", { _tag: "ProviderError" }).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(DiagnosticHashKey, () => key),
      ),
    );
    return lines.join("\n");
  };
  const unkeyed = sha16(ACCOUNT.toLowerCase());
  expect(printed()).not.toContain("accountHash");
  expect(printed()).not.toContain(unkeyed);
  expect(printed(KEY)).toContain(keyedDiagnosticHash(KEY, "account", ACCOUNT));
  expect(printed(KEY)).not.toContain(unkeyed);
});
