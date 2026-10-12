import http from "node:http";

import { Crypto, Deferred, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { AuthError, ProviderError } from "../../errors.js";
import { tokenTimeout } from "../../provider-retry.js";
import { tokenEndpointFailure } from "../../reauth.js";
import { type AuthorizeRequest, Browser, OAuth, type TokenResponse } from "../../services.js";

/**
 * Authorization-code flow with PKCE and a loopback redirect (RFC 8252). The
 * consent page opens in the system browser: Google and Microsoft both refuse
 * sign-in inside embedded webviews.
 *
 * The redirect URI host comes from `redirectHost`, but the server always binds
 * 127.0.0.1. Azure's portal rejects an http 127.0.0.1 redirect but accepts
 * `http://localhost` (any port), so Microsoft passes "localhost", which the
 * browser still resolves to 127.0.0.1.
 */

const TIMEOUT = "5 minutes";

const TokenJson = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Number,
  scope: Schema.optionalKey(Schema.String),
});

// Sign-in failures before there is an account (consent denied, timeout) have
// no account id to report.
const signInFailed = (message: string, reason?: "cancelled" | "timeout") =>
  new AuthError({ accountId: "", message, ...(reason ? { reason } : {}) });

/** A loopback HTTP server on a free port, closed when the scope ends. */
const loopbackServer = Effect.acquireRelease(
  Effect.callback<{ server: http.Server; port: number }>((resume) => {
    const server = http.createServer();
    server.once("error", (error) => resume(Effect.die(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(
        address === null || typeof address === "string"
          ? Effect.die(new Error("Loopback server has no port"))
          : Effect.succeed({ server, port: address.port }),
      );
    });
  }),
  ({ server }) =>
    Effect.sync(() => {
      // The browser keeps the connection alive; close it so close() returns now.
      server.closeAllConnections();
      server.close();
    }),
);

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/**
 * The page the browser shows after the redirect. Core does not know the app's
 * UI language, so it says the same thing in English and Chinese. The provider's
 * error code is reflected, so it is escaped.
 */
function page(error: string | null): string {
  const [en, zh] =
    error === null
      ? [
          "Signed in. You can close this page and go back to openmail.",
          "已登录，可以关闭这个页面回到 openmail。",
        ]
      : [`Sign-in failed: ${escapeHtml(error)}`, `登录失败：${escapeHtml(error)}`];
  return `<meta charset="utf-8"><body style="font:16px system-ui;padding:3rem"><p lang="en">${en}</p><p lang="zh-CN">${zh}</p></body>`;
}

export const OAuthLoopback: Layer.Layer<
  OAuth,
  never,
  Browser | HttpClient.HttpClient | Crypto.Crypto
> = Layer.effect(
  OAuth,
  Effect.gen(function* () {
    const browser = yield* Browser;
    const client = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    // A broken system random source is a defect, not a sign-in failure.
    const random = (size: number) => Effect.orDie(crypto.randomBytes(size));

    // Never put the response body of a successful call in an error or log:
    // it holds the tokens.
    const postToken = (accountId: string, url: string, body: Record<string, string>) =>
      Effect.gen(function* () {
        const res = yield* client
          .execute(
            HttpClientRequest.post(url).pipe(
              HttpClientRequest.bodyUrlParams(body),
              HttpClientRequest.acceptJson,
            ),
          )
          .pipe(
            Effect.mapError(
              () => new ProviderError({ message: "Token endpoint unreachable", status: 0 }),
            ),
          );
        if (res.status < 200 || res.status >= 300) {
          // invalid_grant: the refresh token was revoked, expired (Google's 7-day
          // limit for apps in Testing) or issued to another client. Only the
          // definitive OAuth codes ask for a new sign-in; the rest are retried.
          const text = yield* Effect.orElseSucceed(res.text, () => "");
          return yield* tokenEndpointFailure(accountId, res.status, text);
        }
        const json = yield* HttpClientResponse.schemaBodyJson(TokenJson)(res).pipe(
          Effect.mapError(
            () => new ProviderError({ message: "Token endpoint returned an unexpected body" }),
          ),
        );
        return {
          accessToken: json.access_token,
          refreshToken: Option.fromNullishOr(json.refresh_token),
          expiresIn: json.expires_in,
          ...(json.scope === undefined ? {} : { scopes: json.scope.split(/\s+/).filter(Boolean) }),
        } satisfies TokenResponse;
      }).pipe(tokenTimeout);

    const authorize = Effect.fn("OAuth.authorize")(function* (req: AuthorizeRequest) {
      const verifier = Buffer.from(yield* random(32)).toString("base64url");
      const challenge = Buffer.from(
        yield* Effect.orDie(crypto.digest("SHA-256", Buffer.from(verifier))),
      ).toString("base64url");
      const state = Buffer.from(yield* random(16)).toString("hex");

      const { server, port } = yield* loopbackServer;
      const redirectUri = `http://${req.redirectHost ?? "127.0.0.1"}:${port}`;

      // Listening starts before the browser opens, so an instant redirect is not lost.
      const code = yield* Deferred.make<string, AuthError>();
      // Only a request to the redirect path that carries this sign-in's state may
      // settle it. Anything else (a favicon, another local process probing the
      // port, a forged ?error=) gets a 404 and the sign-in keeps waiting.
      server.on("request", (incoming, res) => {
        const url = new URL(incoming.url ?? "/", redirectUri);
        if (
          incoming.method !== "GET" ||
          url.pathname !== "/" ||
          url.searchParams.get("state") !== state
        ) {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const got = url.searchParams.get("code");
        if (!error && !got) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(page(error));
        Deferred.doneUnsafe(
          code,
          !error && got
            ? Effect.succeed(got)
            : error === "access_denied"
              ? Effect.fail(signInFailed("Sign-in cancelled", "cancelled"))
              : Effect.fail(signInFailed(`Sign-in failed: ${error}`)),
        );
      });

      const auth = new URL(req.authUrl);
      auth.search = new URLSearchParams({
        client_id: req.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: req.scopes.join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...req.extraParams,
      }).toString();
      yield* browser.open(auth.toString());

      const got = yield* Deferred.await(code).pipe(
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () => Effect.fail(signInFailed("Sign-in timed out", "timeout")),
        }),
      );
      return yield* postToken("", req.tokenUrl, {
        grant_type: "authorization_code",
        code: got,
        redirect_uri: redirectUri,
        client_id: req.clientId,
        code_verifier: verifier,
        ...(req.clientSecret ? { client_secret: req.clientSecret } : {}),
      });
    }, Effect.scoped);

    const refresh = Effect.fn("OAuth.refresh")(
      (
        accountId: string,
        req: { tokenUrl: string; clientId: string; clientSecret?: string; refreshToken: string },
      ) =>
        postToken(accountId, req.tokenUrl, {
          grant_type: "refresh_token",
          refresh_token: req.refreshToken,
          client_id: req.clientId,
          ...(req.clientSecret ? { client_secret: req.clientSecret } : {}),
        }),
    );

    return OAuth.of({ authorize, refresh });
  }),
);
