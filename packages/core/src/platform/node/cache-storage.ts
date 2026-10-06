import { lstat, readdir, statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import type { CacheFiles } from "../../cache.js";

/** Counts preserved corrupt/recovery copies without following symlinks or counting hard links twice. */
export async function measureCacheStorage(databaseFile: string): Promise<CacheFiles> {
  if (!databaseFile) return { walBytes: 0, recoveryBytes: 0, disk: null };
  const directory = dirname(databaseFile);
  const name = basename(databaseFile);
  const disk = await statfs(directory).then(
    (info) => ({ freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize }),
    () => null,
  );
  const seen = new Set<string>();
  const main = await lstat(databaseFile).catch(() => null);
  if (main) seen.add(`${main.dev}:${main.ino}`);
  let walBytes = 0;
  let recoveryBytes = 0;
  for (const entry of await readdir(directory)) {
    const wal = entry === `${name}-wal`;
    if (!wal && !entry.startsWith(`${name}.corrupt-`) && !entry.startsWith(`${name}.recovery-`))
      continue;
    const info = await lstat(join(directory, entry)).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const identity = `${info.dev}:${info.ino}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (wal) walBytes += info.size;
    else recoveryBytes += info.size;
  }
  return { walBytes, recoveryBytes, disk };
}
export const nodeCacheStorage = {
  measure: (file: string) =>
    Effect.tryPromise(() => measureCacheStorage(file)).pipe(
      Effect.catch(() => Effect.succeed({ walBytes: 0, recoveryBytes: 0, disk: null })),
    ),
};
