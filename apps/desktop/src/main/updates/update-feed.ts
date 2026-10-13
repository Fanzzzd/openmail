import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether this build updates from a private GitHub repo. electron-builder writes the publish
 * entry (electron-builder.config.cjs) into Resources/app-update.yml, with `private: true` for a
 * private repo; only that feed needs the GitHub access token. A development run has no file.
 */
export function privateUpdateFeed(resourcesPath: string | null): boolean {
  if (!resourcesPath) return false;
  try {
    return /^private:\s*true\s*$/m.test(
      readFileSync(join(resourcesPath, "app-update.yml"), "utf8"),
    );
  } catch {
    return false;
  }
}
