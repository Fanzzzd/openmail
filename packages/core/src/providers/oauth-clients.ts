import { Clock, Effect, Option } from "effect";

import { AuthError, ProviderError } from "../domain/errors.js";
import { isTestingModeExpiry } from "./reauth.js";
import type { AppConfig, ClientConfig, ClientSources, OAuthIssuers } from "../platform/auth.js";

/** Per provider, the first source that has a client. */
export const firstClients = (...sources: readonly ClientConfig[]): ClientConfig => {
  const config: ClientConfig = {};
  const google = sources.find((source) => source.google)?.google;
  const microsoft = sources.find((source) => source.microsoft)?.microsoft;
  if (google) config.google = google;
  if (microsoft) config.microsoft = microsoft;
  return config;
};

/** The clients for new sign-ins: the user's own, then env vars, then the built-in one. */
export const effectiveClients = ({ user, env, builtIn }: ClientSources): ClientConfig =>
  firstClients(user, env, builtIn);

/** Which source new sign-ins use, per provider. Env counts as built-in: the app cannot change it. */
export const activeClient = (
  sources: ClientSources,
  provider: keyof ClientConfig,
): "own" | "builtIn" | "none" =>
  sources.user[provider]
    ? "own"
    : sources.env[provider] || sources.builtIn[provider]
      ? "builtIn"
      : "none";

/**
 * The client to send with a stored refresh token. A token only works with
 * the client that issued it, so a recorded `issuer` must match exactly. An
 * account signed in before issuers were recorded can only have been issued
 * by what the previous version used, env vars then config.json, never a
 * built-in client.
 */
export const clientForToken = <C extends { readonly clientId: string }>(
  issuer: Option.Option<string>,
  sources: { user: C | undefined; env: C | undefined; builtIn: C | undefined },
): C | undefined =>
  Option.isSome(issuer)
    ? [sources.user, sources.env, sources.builtIn].find(
        (client) => client?.clientId === issuer.value,
      )
    : (sources.env ?? sources.user);

/**
 * Refreshes an account's token with the client that issued it, or asks for a
 * new sign-in when that client is gone. An account signed in before issuers
 * were recorded gets its issuer recorded after the first refresh that succeeds.
 * With `testingMode`, an invalid_grant at least 6.5 days after sign-in on a
 * token from the built-in client (its Google app is in Testing) is reported as
 * Google's Testing-mode expiry. The status of an own client is unknown.
 */
export const refreshWithIssuer = <C extends { readonly clientId: string }, A>(
  deps: { config: AppConfig["Service"]; issuers: OAuthIssuers["Service"] },
  provider: {
    name: string;
    pick: (clients: ClientConfig) => C | undefined;
    testingMode?: boolean;
  },
  accountId: string,
  refresh: (client: C) => Effect.Effect<A, AuthError | ProviderError>,
): Effect.Effect<A, AuthError | ProviderError> =>
  Effect.gen(function* () {
    const sources = yield* deps.config.sources;
    const issuer = yield* deps.issuers.get(accountId);
    const client = clientForToken(issuer, {
      user: provider.pick(sources.user),
      env: provider.pick(sources.env),
      builtIn: provider.pick(sources.builtIn),
    });
    if (!client) {
      // A sign-in can fix it when some client exists; otherwise setup is missing.
      if (Option.isSome(issuer) || provider.pick(effectiveClients(sources)))
        return yield* new AuthError({
          accountId,
          message: `The ${provider.name} OAuth client that signed in this account is not configured; sign in again`,
          reason: "client_mismatch",
        });
      return yield* new ProviderError({
        message: `No ${provider.name} OAuth client configured`,
        reason: "configuration",
      });
    }
    const result = yield* refresh(client).pipe(
      Effect.catchIf(
        (error) =>
          provider.testingMode === true &&
          client.clientId === provider.pick(sources.builtIn)?.clientId &&
          error._tag === "AuthError" &&
          error.reason === "token_revoked",
        (error) =>
          Effect.gen(function* () {
            const issued = yield* deps.issuers.issuedAt(accountId);
            const now = yield* Clock.currentTimeMillis;
            return yield* Option.isSome(issued) && isTestingModeExpiry(issued.value, now)
              ? new AuthError({ accountId, message: error.message, reason: "testing_mode_expiry" })
              : error;
          }),
      ),
    );
    if (Option.isNone(issuer)) yield* deps.issuers.set(accountId, client.clientId);
    return result;
  });
