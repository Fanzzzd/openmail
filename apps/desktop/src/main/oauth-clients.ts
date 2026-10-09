import type { ClientConfig } from "@openmail/core";

// electron.vite.config.ts defines this for the main bundle only, so client
// values never reach the renderer or preload. Unset under vitest.
declare const __OPENMAIL_OAUTH_CLIENTS__: ClientConfig | undefined;

/** openmail's own OAuth clients for this build; empty when none were configured. */
export const builtInOAuthClients: ClientConfig =
  typeof __OPENMAIL_OAUTH_CLIENTS__ === "undefined" ? {} : __OPENMAIL_OAUTH_CLIENTS__;
