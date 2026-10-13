/** Platform ports for credentials and sign-in: the keychain, OAuth client config, issuers, the system browser and the OAuth flow. */

import { Context, type Effect, type Option } from "effect";
import type { AuthError, ProviderError } from "../domain/errors.js";

/**
 * Secrets in the OS keychain: OAuth refresh tokens and IMAP passwords, keyed
 * by account id. Never in the database, config.json or logs.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    /** None only when the item does not exist; a locked keychain fails with reason "keychain". */
    get(key: string): Effect.Effect<Option.Option<string>, ProviderError>;
    set(key: string, value: string): Effect.Effect<void, ProviderError>;
    remove(key: string): Effect.Effect<void>;
  }
>()("openmail/Secrets") {}

/** OAuth client registrations, per provider. */
export interface ClientConfig {
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string };
}

/**
 * Where OAuth clients come from. `user` is what the person entered
 * (config.json, mode 600, docs/setup-*.md). `env` is
 * OPENMAIL_GOOGLE_CLIENT_ID/SECRET and OPENMAIL_MICROSOFT_CLIENT_ID at run
 * time. `builtIn` is openmail's own registration, supplied by the host build.
 */
export interface ClientSources {
  user: ClientConfig;
  env: ClientConfig;
  builtIn: ClientConfig;
}

export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly sources: Effect.Effect<ClientSources>;
    /** Writes the user's clients. Other sources are never written. */
    write(patch: ClientConfig): Effect.Effect<void>;
    /** Removes the user's client for one provider, so new sign-ins fall back to the others. */
    clearUser(provider: keyof ClientConfig): Effect.Effect<void>;
  }
>()("openmail/AppConfig") {}

/**
 * The OAuth client ID that issued each account's refresh token
 * (`accounts.oauth_client_id`). Provider adapters read it on refresh.
 */
export class OAuthIssuers extends Context.Service<
  OAuthIssuers,
  {
    get(accountId: string): Effect.Effect<Option.Option<string>>;
    set(accountId: string, clientId: string): Effect.Effect<void>;
    /** When the stored refresh token was issued by a sign-in (`accounts.oauth_issued_at`). */
    issuedAt(accountId: string): Effect.Effect<Option.Option<number>>;
    setIssuedAt(accountId: string, at: number): Effect.Effect<void>;
  }
>()("openmail/OAuthIssuers") {}

/** Opens a URL in the system browser. Consent pages must never open in an embedded webview. */
export class Browser extends Context.Service<Browser, { open(url: string): Effect.Effect<void> }>()(
  "openmail/Browser",
) {}

export interface AuthorizeRequest {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: readonly string[];
  extraParams?: Record<string, string>;
  /** Host written into the loopback redirect URI ("localhost" for Azure). The server binds 127.0.0.1. */
  redirectHost?: string;
  /** Text of the page the browser shows after the redirect, in the app's language. Defaults to English. */
  page?: AuthorizePage;
}

export interface AuthorizePage {
  /** HTML lang of the text, such as "de". */
  lang?: string;
  title?: string;
  doneText?: string;
  /** Shown above the provider's error code. */
  failedText?: string;
}

export interface TokenResponse {
  /** Actual grants reported by the authorization server, never inferred from requested scopes. */
  scopes?: readonly string[];
  accessToken: string;
  refreshToken: Option.Option<string>;
  /** Seconds. */
  expiresIn: number;
}

/**
 * Authorization-code flow with PKCE (RFC 8252). Desktop and CLI use a
 * loopback redirect; mobile will use an app URL scheme behind the same
 * interface. `refresh` maps the definitive OAuth error codes to AuthError (reauth.ts).
 */
export class OAuth extends Context.Service<
  OAuth,
  {
    authorize(req: AuthorizeRequest): Effect.Effect<TokenResponse, AuthError | ProviderError>;
    refresh(
      accountId: string,
      req: { tokenUrl: string; clientId: string; clientSecret?: string; refreshToken: string },
    ): Effect.Effect<TokenResponse, AuthError | ProviderError>;
  }
>()("openmail/OAuth") {}
