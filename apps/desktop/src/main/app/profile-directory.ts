import { resolve } from "node:path";

/**
 * Where Electron keeps the profile (`userData`): Chromium's storage, the single instance lock and
 * opened attachments. `--user-data-dir` wins and also holds the database. Otherwise OPENMAIL_HOME,
 * which core already uses for the database, so a test launch with only OPENMAIL_HOME set never
 * writes into the real profile. With neither, undefined keeps Electron's default. An empty
 * OPENMAIL_HOME counts as unset, as it does for core's dataDir.
 */
export function profileDirectory(
  userDataDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (userDataDir) return resolve(userDataDir);
  const home = env.OPENMAIL_HOME;
  return home ? resolve(home) : undefined;
}
