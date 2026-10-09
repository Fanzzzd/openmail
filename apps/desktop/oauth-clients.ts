import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { clientsFromEnvOrFile, parseClientsFile } from "@openmail/core/oauth-client-sources";

/** Gitignored. Local builds read it; see docs/release.md. */
export const LOCAL_CLIENTS_FILE = fileURLToPath(
  new URL("./oauth-clients.local.json", import.meta.url),
);

/**
 * The built-in clients for a desktop build, with core's parser: per
 * provider, the OPENMAIL_*_CLIENT_* env vars win over the local file. A
 * malformed file fails the build.
 */
export function readBuiltInClients(
  env: Record<string, string | undefined> = process.env,
  file = LOCAL_CLIENTS_FILE,
) {
  return clientsFromEnvOrFile(
    env,
    existsSync(file) ? parseClientsFile(readFileSync(file, "utf8")) : {},
  );
}

const from = (value: "env" | "file" | undefined) =>
  value === "env" ? "env vars" : value === "file" ? "oauth-clients.local.json" : "none";

/** One line for the build log. Names sources, never values. */
export function describeBuiltInClients({ origin }: ReturnType<typeof readBuiltInClients>): string {
  return `Built-in OAuth clients: Google from ${from(origin.google)}, Microsoft from ${from(origin.microsoft)}.`;
}
