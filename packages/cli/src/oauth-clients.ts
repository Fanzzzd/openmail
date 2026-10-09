import { fileURLToPath } from "node:url";

/**
 * openmail's built-in OAuth clients in a source checkout: the same gitignored
 * file the desktop build reads (docs/release.md). OPENMAIL_GOOGLE_CLIENT_ID,
 * OPENMAIL_GOOGLE_CLIENT_SECRET and OPENMAIL_MICROSOFT_CLIENT_ID replace it.
 * Clients saved with `openmail config` win over both.
 */
export const oauthClientsFile = fileURLToPath(
  new URL("../../../apps/desktop/oauth-clients.local.json", import.meta.url),
);
