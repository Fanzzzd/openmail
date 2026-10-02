import { createHash } from "node:crypto";

import { NodeCrypto } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { OAuthLoopback } from "./platform/node/oauth.js";
import { Browser, OAuth } from "./services.js";

/**
 * A browser that "consents" at once: it calls the loopback redirect with a
 * code and the state it was given. A token endpoint that records the form.
 */
const harness = (scope?: string) =>
  Effect.gen(function* () {
    const posted = yield* Ref.make<URLSearchParams | undefined>(undefined);
    const opened = yield* Ref.make<URL | undefined>(undefined);
    const browser = Layer.succeed(
      Browser,
      Browser.of({
        open: (url) =>
          Effect.gen(function* () {
            const auth = new URL(url);
            yield* Ref.set(opened, auth);
            const redirect = new URL(auth.searchParams.get("redirect_uri")!);
            redirect.searchParams.set("code", "the-code");
            redirect.searchParams.set("state", auth.searchParams.get("state")!);
            yield* Effect.promise(() => fetch(redirect));
          }),
      }),
    );
    const http = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.body._tag === "Uint8Array") {
            const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
            yield* Ref.set(posted, form);
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 60,
              ...(scope ? { scope } : {}),
            }),
          );
        }),
      ),
    );
    const layer = OAuthLoopback.pipe(Layer.provide([browser, http, NodeCrypto.layer]));
    return { posted, opened, layer };
  });

it.live("authorize runs PKCE over a loopback redirect", () =>
  Effect.gen(function* () {
    const { posted, opened, layer } = yield* harness();
    const tokens = yield* Effect.gen(function* () {
      const oauth = yield* OAuth;
      return yield* oauth.authorize({
        authUrl: "https://accounts.example.com/auth",
        tokenUrl: "https://accounts.example.com/token",
        clientId: "client",
        scopes: ["mail.read", "offline"],
      });
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(tokens, {
      accessToken: "at",
      refreshToken: Option.some("rt"),
      expiresIn: 60,
    });

    const auth = yield* Ref.get(opened);
    const form = yield* Ref.get(posted);
    assert.ok(auth && form);
    assert.strictEqual(auth.searchParams.get("code_challenge_method"), "S256");
    assert.strictEqual(auth.searchParams.get("scope"), "mail.read offline");
    assert.match(auth.searchParams.get("state") ?? "", /^[0-9a-f]{32}$/);
    assert.match(auth.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.strictEqual(form.get("code"), "the-code");
    assert.strictEqual(form.get("redirect_uri"), auth.searchParams.get("redirect_uri"));
    // The challenge sent to the consent page is SHA-256 of the verifier sent to the token endpoint.
    const verifier = form.get("code_verifier") ?? "";
    assert.match(verifier, /^[\w-]{43}$/);
    assert.strictEqual(
      auth.searchParams.get("code_challenge"),
      createHash("sha256").update(verifier).digest("base64url"),
    );
  }),
);

it.live("OAuth reports actual granted scopes rather than requested scopes", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness("mail.read https://mail.google.com/");
    const tokens = yield* Effect.gen(function* () {
      const oauth = yield* OAuth;
      return yield* oauth.authorize({
        authUrl: "https://accounts.example.com/auth",
        tokenUrl: "https://accounts.example.com/token",
        clientId: "own-client",
        scopes: ["mail.read", "https://mail.google.com/", "declined.scope"],
        extraParams: { include_granted_scopes: "true" },
      });
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(tokens.scopes, ["mail.read", "https://mail.google.com/"]);
  }),
);
