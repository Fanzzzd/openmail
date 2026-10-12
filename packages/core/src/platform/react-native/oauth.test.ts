import { describe, expect, it, vi } from "vitest";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { OAuth } from "../../services.js";
import { mobileOAuthLayer } from "./oauth.js";

const tokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const request = {
  authUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
  tokenUrl,
  clientId: "registered-client",
  scopes: ["Mail.ReadWrite"],
};
it("exchanges a PKCE authorization code with fetch, preserving actual grants and omitting client secrets", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "Mail.ReadWrite offline_access",
    }),
  );
  const layer = mobileOAuthLayer({
    authorize: async () => ({
      code: "code",
      verifier: "verifier",
      redirectUri: "msauth.com.openmail.mobile://auth",
    }),
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const oauth = yield* OAuth;
      const result = yield* oauth.authorize(request);
      expect(result.scopes).toEqual(["Mail.ReadWrite", "offline_access"]);
      expect(Option.getOrNull(result.refreshToken)).toBe("refresh");
    }).pipe(Effect.provide(layer)),
  );
  const call = fetch.mock.calls[0];
  const input = call?.[0];
  expect(input instanceof URL ? input.href : typeof input === "string" ? input : input?.url).toBe(
    tokenUrl,
  );
  const body = await new Response(call?.[1]?.body).text();
  expect(new URLSearchParams(body).get("code_verifier")).toBe("verifier");
  expect(new URLSearchParams(body).has("client_secret")).toBe(false);
});

describe("mobile refresh failures", () => {
  it("maps invalid_grant to AuthError, redacts responses, and refuses non-consumers endpoints", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: "invalid_grant",
          refresh_token: "must-not-leak",
          error_description: "private",
        },
        { status: 400 },
      ),
    );
    const layer = mobileOAuthLayer({ authorize: () => Promise.reject(new Error("unused")) }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const oauth = yield* OAuth;
        const result = yield* oauth
          .refresh("outlook:test", { tokenUrl, clientId: "id", refreshToken: "secret" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("AuthError");
          expect(result.failure.message).not.toContain("must-not-leak");
          expect(result.failure.message).not.toContain("private");
        }
        yield* oauth
          .refresh("outlook:test", {
            tokenUrl: tokenUrl.replace("consumers", "common"),
            clientId: "id",
            refreshToken: "secret",
          })
          .pipe(Effect.result);
        expect(fetch).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("mobile sign-in failures", () => {
  const layer = (authorize: () => Promise<null>) =>
    mobileOAuthLayer({ authorize }).pipe(Layer.provide(FetchHttpClient.layer));
  it("reports a cancelled browser as a cancelled sign-in", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const oauth = yield* OAuth;
        return yield* Effect.flip(oauth.authorize(request));
      }).pipe(Effect.provide(layer(async () => null))),
    );
    expect(error._tag === "AuthError" && error.reason).toBe("cancelled");
  });
});
