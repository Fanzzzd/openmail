import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const TEST_TEMP_PREFIX = "openmail-tests-";
const MAX_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

/** Only sweep this helper's roots; do not follow symlinks into other temp data. */
export function sweepOldTestTempDirectories(parent: string, now = Date.now()): void {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(TEST_TEMP_PREFIX) || !entry.isDirectory()) continue;
    const directory = join(parent, entry.name);
    try {
      const info = lstatSync(directory);
      if (info.isDirectory() && info.mtimeMs < now - MAX_TEMP_AGE_MS)
        rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      // Another project's startup may have removed the same stale root.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

/** Each Vitest project owns its temp root, so parallel suites cannot mask leaks. */
export function removeTestTempDirectory(directory: string): void {
  try {
    // Vitest keeps its own randomly named worker cache here until after global
    // teardown. Check fixture namespaces, including nested fixtures, instead.
    const leftovers = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(
      (entry) => /^(?:openmail|om)-/.test(basename(entry)),
    );
    if (leftovers.length)
      throw new Error(`Test temp files leaked: ${leftovers.toSorted().join(", ")}`);
  } finally {
    // Even a failed assertion or worker crash must not leave a large fixture behind.
    rmSync(directory, { recursive: true, force: true });
  }
}

export default function setup() {
  const previous = process.env.TMPDIR;
  const parent = tmpdir();
  sweepOldTestTempDirectories(parent);
  const directory = mkdtempSync(join(parent, TEST_TEMP_PREFIX));
  process.env.TMPDIR = directory;
  return () => {
    try {
      removeTestTempDirectory(directory);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  };
}
