import type { ClientConfig } from "../services.js";

/**
 * Parsing for OAuth client values outside config.json, with no runtime
 * dependencies. The desktop build config, core's Config layer and the CLI
 * all use it, so the env vars and the local file mean the same everywhere.
 */

export const CLIENT_ENV_VARS = [
  "OPENMAIL_GOOGLE_CLIENT_ID",
  "OPENMAIL_GOOGLE_CLIENT_SECRET",
  "OPENMAIL_MICROSOFT_CLIENT_ID",
] as const;

type Env = Readonly<Partial<Record<string, string | undefined>>>;

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

const clients = (
  googleId: string | undefined,
  googleSecret: string | undefined,
  microsoftId: string | undefined,
): ClientConfig => ({
  ...(googleId && googleSecret
    ? { google: { clientId: googleId, clientSecret: googleSecret } }
    : {}),
  ...(microsoftId ? { microsoft: { clientId: microsoftId } } : {}),
});

/** Clients from the env vars. A Google client ID without its secret is ignored. */
export const clientsFromEnv = (env: Env): ClientConfig =>
  clients(
    text(env.OPENMAIL_GOOGLE_CLIENT_ID),
    text(env.OPENMAIL_GOOGLE_CLIENT_SECRET),
    text(env.OPENMAIL_MICROSOFT_CLIENT_ID),
  );

/** A clients file shaped like config.json. Throws on JSON that is not an object. */
export function parseClientsFile(json: string): ClientConfig {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("OAuth clients file must hold a JSON object");
  const file = record(parsed);
  const google = record(file.google);
  const microsoft = record(file.microsoft);
  return clients(text(google.clientId), text(google.clientSecret), text(microsoft.clientId));
}

export type ClientOrigin = "env" | "file";

/**
 * Per provider, env vars win over the file. `origin` says where each
 * provider's client came from, for a build notice that never prints values.
 */
export function clientsFromEnvOrFile(
  env: Env,
  file: ClientConfig,
): {
  clients: ClientConfig;
  origin: { google?: ClientOrigin; microsoft?: ClientOrigin };
} {
  const fromEnv = clientsFromEnv(env);
  const google = fromEnv.google ?? file.google;
  const microsoft = fromEnv.microsoft ?? file.microsoft;
  return {
    clients: { ...(google ? { google } : {}), ...(microsoft ? { microsoft } : {}) },
    origin: {
      ...(google ? { google: fromEnv.google ? "env" : "file" } : {}),
      ...(microsoft ? { microsoft: fromEnv.microsoft ? "env" : "file" } : {}),
    },
  };
}
