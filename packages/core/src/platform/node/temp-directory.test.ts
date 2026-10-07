import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  removeTestTempDirectory,
  sweepOldTestTempDirectories,
} from "../../../test-support/temp-directory.js";

it("fails on leaked fixtures and removes them even when teardown fails", () => {
  const root = mkdtempSync(join(tmpdir(), "openmail-temp-guard-"));
  try {
    const fixture = join(root, "openmail-100k-fixture");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "mail.db"), "fixture");
    expect(() => removeTestTempDirectory(root)).toThrow("openmail-100k-fixture");
    expect(existsSync(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("startup sweeps only helper roots older than 24 hours and leaves symlinks untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "openmail-temp-sweep-"));
  const now = Date.now();
  const age = (path: string, hours: number) => {
    const time = new Date(now - hours * 60 * 60 * 1000);
    utimesSync(path, time, time);
  };
  try {
    const old = join(root, "openmail-tests-old");
    const fresh = join(root, "openmail-tests-fresh");
    const boundary = join(root, "openmail-tests-exactly-24h");
    const unrelated = join(root, "openmail-perf61-old");
    for (const directory of [old, fresh, boundary, unrelated]) mkdirSync(directory);
    writeFileSync(join(old, "mail.db"), "fixture");
    writeFileSync(join(unrelated, "mail.db"), "unrelated fixture");
    age(old, 25);
    age(fresh, 23);
    age(boundary, 24);
    age(unrelated, 25);
    const link = join(root, "openmail-tests-link");
    symlinkSync(unrelated, link, "dir");
    const file = join(root, "openmail-tests-file");
    writeFileSync(file, "not a helper root");
    age(file, 25);
    sweepOldTestTempDirectories(root, now);
    expect(existsSync(old)).toBe(false);
    for (const path of [fresh, boundary, unrelated, file]) expect(existsSync(path)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Concurrent startup can safely repeat a sweep that a peer already completed.
    sweepOldTestTempDirectories(root, now);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("removes an empty test temp root", () => {
  const root = mkdtempSync(join(tmpdir(), "openmail-temp-guard-"));
  try {
    removeTestTempDirectory(root);
    expect(existsSync(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
