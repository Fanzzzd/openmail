import { createHash } from "node:crypto";
import net from "node:net";

import { NodeCrypto } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { OAuthLoopback, withAuthorizePage } from "./platform/node/oauth.js";
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

it.effect("an offline token endpoint is a transport failure with status zero", () => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "offline" }),
        }),
      ),
    ),
  );
  const layer = OAuthLoopback.pipe(
    Layer.provide([http, NodeCrypto.layer, Layer.succeed(Browser, { open: () => Effect.void })]),
  );
  return Effect.gen(function* () {
    const oauth = yield* OAuth;
    const error = yield* oauth
      .refresh("account", {
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: "client",
        refreshToken: "refresh",
      })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProviderError");
    if (error._tag === "ProviderError") assert.strictEqual(error.status, 0);
  }).pipe(Effect.provide(layer));
});

/** A loopback whose browser runs `visit` with the consent URL instead of consenting. */
const visiting = (visit: (auth: URL, redirect: URL) => Promise<void>) => {
  const browser = Layer.succeed(
    Browser,
    Browser.of({
      open: (url) =>
        Effect.promise(() => {
          const auth = new URL(url);
          return visit(auth, new URL(auth.searchParams.get("redirect_uri")!));
        }),
    }),
  );
  const http = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ access_token: "at", refresh_token: "rt", expires_in: 60 }),
        ),
      ),
    ),
  );
  return OAuthLoopback.pipe(Layer.provide([browser, http, NodeCrypto.layer]));
};

const signIn = Effect.gen(function* () {
  const oauth = yield* OAuth;
  return yield* oauth.authorize({
    authUrl: "https://accounts.example.com/auth",
    tokenUrl: "https://accounts.example.com/token",
    clientId: "client",
    scopes: ["mail.read"],
  });
});

const withParams = (redirect: URL, params: Record<string, string>, path = "/") => {
  const url = new URL(path, redirect);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
};

it.live("the loopback ignores requests without this sign-in's state", () =>
  Effect.gen(function* () {
    const statuses: number[] = [];
    const layer = visiting(async (auth, redirect) => {
      const state = auth.searchParams.get("state")!;
      for (const url of [
        withParams(redirect, {}, "/favicon.ico"),
        withParams(redirect, { error: "access_denied" }),
        withParams(redirect, { error: "access_denied", state: "forged" }),
        withParams(redirect, { code: "stolen", state: "forged" }),
        withParams(redirect, { code: "the-code", state }, "/elsewhere"),
      ])
        statuses.push((await fetch(url)).status);
      statuses.push((await fetch(withParams(redirect, { code: "the-code", state }))).status);
    });
    const tokens = yield* signIn.pipe(Effect.provide(layer));
    assert.strictEqual(tokens.accessToken, "at");
    assert.deepStrictEqual(statuses, [404, 404, 404, 404, 404, 200]);
  }),
);

it.live("the loopback page escapes the reflected error", () =>
  Effect.gen(function* () {
    let body = "";
    const layer = visiting(async (auth, redirect) => {
      const state = auth.searchParams.get("state")!;
      const res = await fetch(
        withParams(redirect, { error: "<img src=x onerror=alert(1)>", state }),
      );
      body = await res.text();
    });
    const error = yield* signIn.pipe(Effect.provide(layer), Effect.flip);
    assert.strictEqual(error._tag, "AuthError");
    assert.notInclude(body, "<img");
    assert.include(body, "&lt;img src=x onerror=alert(1)&gt;");
  }),
);

it.live("a denied consent page is a cancelled sign-in", () =>
  Effect.gen(function* () {
    const layer = visiting(async (auth, redirect) => {
      const state = auth.searchParams.get("state")!;
      await fetch(withParams(redirect, { error: "access_denied", state }));
    });
    const error = yield* signIn.pipe(Effect.provide(layer), Effect.flip);
    assert.strictEqual(error._tag === "AuthError" && error.reason, "cancelled");
  }),
);

it.effect("a sign-in without a redirect times out with a timeout reason", () =>
  Effect.gen(function* () {
    const fiber = yield* signIn.pipe(
      Effect.provide(visiting(() => Promise.resolve())),
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 minutes");
    const error = yield* Fiber.join(fiber);
    assert.strictEqual(error._tag === "AuthError" && error.reason, "timeout");
  }),
);

it.live("interrupting a sign-in closes the loopback server", () =>
  Effect.gen(function* () {
    const opened = yield* Deferred.make<URL>();
    const layer = visiting(async (_auth, redirect) => {
      Deferred.doneUnsafe(opened, Effect.succeed(redirect));
    });
    const fiber = yield* signIn.pipe(Effect.provide(layer), Effect.forkChild);
    const redirect = yield* Deferred.await(opened);
    yield* Fiber.interrupt(fiber);
    const refused = yield* Effect.promise(() =>
      fetch(redirect).then(
        () => false,
        () => true,
      ),
    );
    assert.isTrue(refused);
  }),
);

/** Writes `request` on a raw socket, so the request line can be something no HTTP client sends. */
const rawRequest = (redirect: URL, request: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = net.connect(Number(redirect.port), "127.0.0.1", () => socket.write(request));
    let reply = "";
    socket.on("data", (chunk) => {
      reply += String(chunk);
      if (reply.includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });

it.live("a malformed request target gets a 404 and the sign-in keeps waiting", () =>
  Effect.gen(function* () {
    const replies: string[] = [];
    const layer = visiting(async (auth, redirect) => {
      const state = auth.searchParams.get("state")!;
      replies.push(await rawRequest(redirect, "GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
      replies.push(await rawRequest(redirect, "GET http://[/?x HTTP/1.1\r\nHost: x\r\n\r\n"));
      await fetch(withParams(redirect, { code: "the-code", state }));
    });
    const tokens = yield* signIn.pipe(Effect.provide(layer));
    assert.strictEqual(tokens.accessToken, "at");
    assert.deepStrictEqual(
      replies.map((reply) => reply.split("\r\n")[0]),
      ["HTTP/1.1 404 Not Found", "HTTP/1.1 404 Not Found"],
    );
  }),
);

it.live("the result page shows the caller's text, escaped, and English by default", () =>
  Effect.gen(function* () {
    const pages: string[] = [];
    const visit = (params: Record<string, string>) =>
      visiting(async (auth, redirect) => {
        const state = auth.searchParams.get("state")!;
        pages.push(await (await fetch(withParams(redirect, { ...params, state }))).text());
      });
    yield* signIn.pipe(Effect.provide(visit({ code: "the-code" })));
    const localized = (params: Record<string, string>) =>
      withAuthorizePage(visit(params), async () => ({
        lang: "de",
        title: "Anmeldung <openmail>",
        doneText: "Angemeldet. <b>Sie</b> können diese Seite schließen.",
        failedText: "Anmeldung fehlgeschlagen & abgebrochen.",
      }));
    yield* signIn.pipe(Effect.provide(localized({ code: "the-code" })));
    yield* signIn.pipe(Effect.provide(localized({ error: "server_error" })), Effect.flip);
    // A failed catalog lookup falls back to English.
    yield* signIn.pipe(
      Effect.provide(
        withAuthorizePage(visit({ code: "the-code" }), () =>
          Promise.reject(new Error("no catalog")),
        ),
      ),
    );
    const [english, done, failed, fallback] = pages;
    assert.include(english, 'lang="en"');
    assert.include(english, "Signed in. You can close this page and go back to openmail.");
    assert.notInclude(english, "已登录");
    assert.include(done, 'lang="de"');
    assert.include(done, "<title>Anmeldung &lt;openmail&gt;</title>");
    assert.include(done, "Angemeldet. &lt;b&gt;Sie&lt;/b&gt; können diese Seite schließen.");
    assert.include(failed, "Anmeldung fehlgeschlagen &amp; abgebrochen.");
    assert.include(failed, "<code>server_error</code>");
    assert.include(fallback, "Signed in.");
  }),
);
