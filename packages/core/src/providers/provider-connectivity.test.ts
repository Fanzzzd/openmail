import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger, Option } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { makeGmail } from "./gmail/gmail.js";
import { makeOutlook } from "./outlook/outlook.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import type { Account } from "../domain/domain.js";

for (const provider of ["gmail", "outlook"] as const) {
  it.effect(
    `${provider} API transport failures share backoff and recover immediately on network change`,
    () => {
      const account: Account = {
        id: `${provider}:me@example.test`,
        provider,
        email: "me@example.test",
        createdAt: 0,
        lastSyncedAt: 0,
        lastSyncError: null,
        profileId: null,
        needsReauth: false,
      };
      let diagnostics = 0;
      const logger = Logger.make(() => {
        diagnostics++;
      });
      let requests = 0;
      let offline = true;
      const client = HttpClient.make((request) =>
        Effect.suspend(() => {
          requests++;
          return offline
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request, description: "offline" }),
                }),
              )
            : Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    id: "inbox",
                    messagesTotal: 1,
                    messagesUnread: 0,
                    threadsTotal: 1,
                    totalItemCount: 1,
                    unreadItemCount: 0,
                  }),
                ),
              );
        }),
      );
      return (provider === "gmail" ? makeGmail : makeOutlook).pipe(
        Effect.flatMap((adapter) =>
          Effect.gen(function* () {
            const attempt = () => adapter.folderStatus(account, "INBOX").pipe(Effect.result);
            const first = yield* attempt().pipe(Effect.forkChild);
            yield* TestClock.adjust("1 second");
            assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
            assert.strictEqual(requests, 2);
            assert.strictEqual(diagnostics, 1);
            for (let tick = 0; tick < 10; tick++) yield* attempt();
            assert.strictEqual(requests, 2);
            assert.strictEqual(diagnostics, 1);
            yield* TestClock.adjust("5 seconds");
            const next = yield* attempt().pipe(Effect.forkChild);
            yield* TestClock.adjust("1 second");
            yield* Fiber.join(next);
            assert.strictEqual(requests, 4);
            yield* TestClock.adjust("5 seconds");
            yield* attempt();
            assert.strictEqual(requests, 4);
            assert.strictEqual(diagnostics, 2);
            offline = false;
            yield* adapter.resetConnectivity?.() ?? Effect.void;
            assert.strictEqual((yield* attempt())._tag, "Success");
            assert.strictEqual(requests, 5);
            // A successful probe restores normal requests rather than retaining the outage counter.
            assert.strictEqual((yield* attempt())._tag, "Success");
            assert.strictEqual(requests, 6);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            MemoryPlatform({
              secrets: { [account.id]: "refresh" },
              tokens: { accessToken: "access", refreshToken: Option.none(), expiresIn: 3600 },
              config: {
                google: { clientId: "google", clientSecret: "secret" },
                microsoft: { clientId: "microsoft" },
              },
            }),
          ),
        ),
        Effect.provide(Logger.layer([logger])),
      );
    },
  );
}

for (const provider of ["gmail", "outlook"] as const) {
  it.effect(`${provider} cached-token send bypasses outage backoff and resets it`, () => {
    const account: Account = {
      id: `${provider}:me@example.test`,
      provider,
      email: "me@example.test",
      createdAt: 0,
      lastSyncedAt: 0,
      lastSyncError: null,
      profileId: null,
      needsReauth: false,
    };
    let offline = true;
    const posts: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.suspend(() => {
        if (offline)
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          );
        if (request.method === "POST") posts.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: "sent",
              messagesTotal: 1,
              messagesUnread: 0,
              threadsTotal: 1,
              totalItemCount: 1,
              unreadItemCount: 0,
            }),
          ),
        );
      }),
    );
    return (provider === "gmail" ? makeGmail : makeOutlook).pipe(
      Effect.flatMap((adapter) =>
        Effect.gen(function* () {
          const failed = yield* adapter
            .folderStatus(account, "INBOX")
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(failed);
          offline = false;
          yield* adapter.send(
            account,
            {
              to: [{ name: "", address: "you@example.test" }],
              cc: [],
              bcc: [],
              subject: "Test",
              text: "Test",
              attachments: [],
            },
            Option.none(),
          );
          assert.strictEqual(posts.length, 1);
          assert.strictEqual(
            (yield* adapter.folderStatus(account, "INBOX").pipe(Effect.result))._tag,
            "Success",
          );
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          MemoryPlatform({
            secrets: { [account.id]: "refresh" },
            tokens: { accessToken: "cached", refreshToken: Option.none(), expiresIn: 3600 },
            config: {
              google: { clientId: "google", clientSecret: "secret" },
              microsoft: { clientId: "microsoft" },
            },
          }),
        ),
      ),
    );
  });
}

it.effect("only explicit transport failures enter outage backoff", () =>
  Effect.gen(function* () {
    const { makeProviderConnectivity } = yield* Effect.promise(
      () => import("./provider-connectivity.js"),
    );
    const { ProviderError } = yield* Effect.promise(() => import("../domain/errors.js"));
    const connectivity = makeProviderConnectivity();
    for (const error of [
      new ProviderError({ message: "Invalid response" }),
      new ProviderError({ message: "Server error", status: 500 }),
      new ProviderError({ message: "Deferred", status: 0, deferred: true }),
    ]) {
      yield* connectivity.run("account", Effect.fail(error)).pipe(Effect.result);
      assert.strictEqual(yield* connectivity.run("account", Effect.succeed("probe")), "probe");
    }
    yield* connectivity
      .run("account", Effect.fail(new ProviderError({ message: "Offline", status: 0 })))
      .pipe(Effect.result);
    assert.strictEqual(
      (yield* connectivity.run("account", Effect.succeed("probe")).pipe(Effect.result))._tag,
      "Failure",
    );
  }),
);

for (const provider of ["gmail", "outlook"] as const)
  for (const read of ["body", "raw", "attachment"] as const) {
    it.effect(
      `${provider} user ${read} reads bypass backoff and restore background requests`,
      () => {
        const account: Account = {
          id: `${provider}:me@example.test`,
          provider,
          email: "me@example.test",
          createdAt: 0,
          lastSyncedAt: 0,
          lastSyncError: null,
          profileId: null,
          needsReauth: false,
        };
        let offline = true;
        const client = HttpClient.make((request, url) =>
          Effect.suspend(() => {
            if (offline)
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              );
            let response: Response;
            if (url.pathname.endsWith("/$value")) response = new Response("Test");
            else if (url.pathname.endsWith("/attachments"))
              response = Response.json({
                value: [
                  {
                    id: "part",
                    name: "file.txt",
                    contentType: "text/plain",
                    size: 4,
                    isInline: false,
                  },
                ],
              });
            else if (url.pathname.endsWith("/messages/body"))
              response =
                provider === "outlook"
                  ? Response.json({
                      id: "body",
                      conversationId: "thread",
                      parentFolderId: "id-inbox",
                      hasAttachments: false,
                      body: { contentType: "text", content: "Test" },
                      receivedDateTime: "2026-10-01T00:00:00Z",
                    })
                  : Response.json(
                      url.searchParams.get("format") === "raw"
                        ? { raw: "VGVzdA==" }
                        : {
                            id: "body",
                            threadId: "thread",
                            internalDate: "1000",
                            labelIds: ["INBOX"],
                            payload: {
                              mimeType: "multipart/mixed",
                              headers: [],
                              body: { size: 8 },
                              parts: [
                                { mimeType: "text/plain", body: { data: "VGVzdA==", size: 4 } },
                                {
                                  mimeType: "text/plain",
                                  filename: "file.txt",
                                  body: { data: "VGVzdA==", size: 4 },
                                },
                              ],
                            },
                          },
                    );
            else
              response = Response.json({
                id: `id-${url.pathname.split("/").at(-1)}`,
                messagesTotal: 1,
                messagesUnread: 0,
                threadsTotal: 1,
                totalItemCount: 1,
                unreadItemCount: 0,
              });
            return Effect.succeed(HttpClientResponse.fromWeb(request, response));
          }),
        );
        return (provider === "gmail" ? makeGmail : makeOutlook).pipe(
          Effect.flatMap((adapter) =>
            Effect.gen(function* () {
              const outage = yield* adapter
                .folderStatus(account, "INBOX")
                .pipe(Effect.result, Effect.forkChild);
              yield* TestClock.adjust("1 second");
              yield* Fiber.join(outage);
              offline = false;
              if (read === "body")
                assert.strictEqual((yield* adapter.fetchMessage(account, "body")).bodyText, "Test");
              else {
                const bytes = yield* read === "raw"
                  ? adapter.fetchRaw(account, "body")
                  : adapter.fetchAttachment(account, "body", {
                      index: 0,
                      filename: "file.txt",
                      occurrence: 0,
                    });
                assert.strictEqual(new TextDecoder().decode(bytes), "Test");
              }
              assert.strictEqual((yield* adapter.folderStatus(account, "INBOX")).total, 1);
            }),
          ),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, client),
              MemoryPlatform({
                secrets: { [account.id]: "refresh" },
                tokens: { accessToken: "cached", refreshToken: Option.none(), expiresIn: 3600 },
                config: {
                  google: { clientId: "google", clientSecret: "secret" },
                  microsoft: { clientId: "microsoft" },
                },
              }),
            ),
          ),
        );
      },
    );
  }
