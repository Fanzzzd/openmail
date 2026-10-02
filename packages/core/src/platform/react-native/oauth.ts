import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AuthError, ProviderError } from "../../errors.js";
import { OAuth, type AuthorizeRequest, type TokenResponse } from "../../services.js";

export interface MobileAuthSession {
  /** AuthSession owns secure state, S256 challenge and system browser completion. */
  authorize(request: AuthorizeRequest): Promise<{
    code: string;
    verifier: string;
    redirectUri: string;
  }>;
}
const TokenJson = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Number,
  scope: Schema.optionalKey(Schema.String),
});
const allowedTokenUrls = new Set([
  "https://oauth2.googleapis.com/token",
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
]);

/** All token HTTP remains inside core; a public mobile client never sends a secret. */
export const mobileOAuthLayer = (session: MobileAuthSession) =>
  Layer.effect(
    OAuth,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const post = (accountId: string, tokenUrl: string, fields: Record<string, string>) =>
        Effect.gen(function* () {
          if (!allowedTokenUrls.has(tokenUrl)) {
            return yield* new ProviderError({ message: "Unsupported mobile token endpoint" });
          }
          const response = yield* http
            .execute(
              HttpClientRequest.post(tokenUrl).pipe(
                HttpClientRequest.bodyUrlParams(fields),
                HttpClientRequest.acceptJson,
              ),
            )
            .pipe(
              Effect.mapError(() => new ProviderError({ message: "Token endpoint unreachable" })),
            );
          if (response.status < 200 || response.status >= 300) {
            // Inspect only the machine error code. Never expose tokens or response bodies.
            const error = yield* response.json.pipe(Effect.orElseSucceed(() => null));
            if (
              typeof error === "object" &&
              error !== null &&
              "error" in error &&
              error.error === "invalid_grant"
            ) {
              return yield* new AuthError({ accountId, message: "Sign-in expired; sign in again" });
            }
            return yield* new ProviderError({
              message: "Token exchange failed",
              status: response.status,
            });
          }
          const token = yield* HttpClientResponse.schemaBodyJson(TokenJson)(response).pipe(
            Effect.mapError(() => new ProviderError({ message: "Unexpected token response" })),
          );
          return {
            accessToken: token.access_token,
            refreshToken: Option.fromNullishOr(token.refresh_token),
            expiresIn: token.expires_in,
            ...(token.scope === undefined
              ? {}
              : { scopes: token.scope.split(/\s+/).filter(Boolean) }),
          } satisfies TokenResponse;
        });
      return OAuth.of({
        authorize: (request) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise({
              try: () => session.authorize(request),
              catch: () =>
                new AuthError({
                  accountId: "",
                  message: "Sign-in cancelled or authorization failed",
                }),
            }).pipe(
              Effect.timeout("5 minutes"),
              Effect.mapError(
                () =>
                  new AuthError({
                    accountId: "",
                    message: "Sign-in cancelled or authorization failed",
                  }),
              ),
            );
            return yield* post("", request.tokenUrl, {
              grant_type: "authorization_code",
              client_id: request.clientId,
              code: result.code,
              code_verifier: result.verifier,
              redirect_uri: result.redirectUri,
            });
          }),
        refresh: (accountId, request) =>
          post(accountId, request.tokenUrl, {
            grant_type: "refresh_token",
            client_id: request.clientId,
            refresh_token: request.refreshToken,
          }),
      });
    }),
  );
