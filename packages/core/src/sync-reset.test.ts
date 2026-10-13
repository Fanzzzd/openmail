import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { type IncomingMessage, type Provider } from "./domain/domain.js";
import { makeGmail } from "./gmail.js";
import { makeOutlook } from "./outlook.js";
import { MailboxLive } from "./mailbox/mailbox-live.js";
import { Mailbox } from "./mailbox/mailbox.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { makeFakeProvider, fakeServer } from "./platform/node/fake-provider.js";
import { Providers, Store, type ProviderAdapter } from "./services.js";
import { StoreLive } from "./store.js";
import { makeResetGuard } from "./sync-reset.js";
import { parseGmailBatch } from "./provider-batch.js";
const mail = (providerId: string): IncomingMessage => ({
  providerId,
  threadId: providerId,
  subject: "Cached mail",
  from: { name: "", address: "sender@example.test" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "cached",
  bodyText: "full cached body",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD"],
  attachments: [],
  isUnread: true,
  isStarred: false,
});
const Requests = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      headers: Schema.Struct({ prefer: Schema.String }),
    }),
  ),
});
type Outcome = "present" | "gone" | "moved" | "deferred";
function httpProvider(
  provider: "gmail" | "outlook",
  outcome: Outcome,
  partial = false,
  options: {
    listed?: number;
    now?: number;
    missingCheckpoint?: boolean;
    verificationStatus?: number;
    omitLabels?: boolean;
  } = {},
) {
  const batches: number[] = [];
  const deltaUrls: URL[] = [];
  const verifiedIds: string[] = [];
  let expired = 0;
  let batchCalls = 0;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      let status = 200;
      let body: unknown;
      let responseText: string | undefined;
      let headers: Record<string, string> | undefined;
      const requestText =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      if (url.pathname.endsWith("/token")) body = { access_token: "access", expires_in: 3600 };
      else if (url.pathname.endsWith("/$batch") || url.pathname.endsWith("/batch/gmail/v1")) {
        const entries =
          provider === "outlook"
            ? Schema.decodeUnknownSync(Schema.fromJsonString(Requests))(requestText).requests
            : [...requestText.matchAll(/Content-ID: <(\d+)>\r\n\r\nGET ([^ ]+) HTTP/g)].map(
                (match) => ({ id: match[1] ?? "", url: match[2] ?? "", headers: { prefer: "" } }),
              );
        assert.isAtMost(entries.length, 20);
        const metadata = entries.every(
          (entry) =>
            new URL(entry.url, "https://example.test").searchParams.get("$select") ===
            "internetMessageId,internetMessageHeaders",
        );
        if (metadata) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                responses: entries.map((entry) => {
                  const id = decodeURIComponent(
                    new URL(entry.url, "https://example.test").pathname.split("/").at(-1) ?? "",
                  );
                  assert.strictEqual(entry.headers.prefer, 'IdType="ImmutableId"');
                  return {
                    id: entry.id,
                    status: 200,
                    body: {
                      internetMessageId: `<${id}@example.test>`,
                      internetMessageHeaders: [
                        { name: "Message-ID", value: `<${id}@example.test>` },
                      ],
                    },
                  };
                }),
              }),
              { status: 200 },
            ),
          );
        }
        batchCalls++;
        batches.push(entries.length);
        const responses = entries.map((entry) => {
          const path = new URL(entry.url, "https://example.test");
          const id = decodeURIComponent(path.pathname.split("/").at(-1) ?? "");
          verifiedIds.push(id);
          if (provider === "outlook") {
            assert.strictEqual(path.searchParams.get("$select"), "id,parentFolderId");
            assert.strictEqual(entry.headers.prefer, 'IdType="ImmutableId"');
          } else assert.strictEqual(path.searchParams.get("format"), "minimal");
          return {
            id: entry.id,
            status:
              options.verificationStatus ??
              (outcome === "gone" ? 404 : outcome === "deferred" ? 429 : 200),
            headers: outcome === "deferred" ? { "Retry-After": "120" } : {},
            body:
              provider === "outlook"
                ? { id, parentFolderId: outcome === "moved" ? "folder-archive" : "folder-inbox" }
                : {
                    id,
                    ...(options.omitLabels
                      ? {}
                      : { labelIds: outcome === "moved" ? ["UNREAD"] : ["INBOX", "UNREAD"] }),
                  },
          };
        });
        if (provider === "outlook") body = { responses };
        else {
          headers = { "content-type": 'multipart/mixed; boundary="response_boundary"' };
          const parts = responses
            .map(
              (item) =>
                `--response_boundary\r\nContent-Type: application/http\r\nContent-ID: <response-${item.id}>\r\n\r\nHTTP/1.1 ${item.status} Result\r\nContent-Type: application/json\r\n${outcome === "deferred" ? "Retry-After: 120\r\n" : ""}\r\n${JSON.stringify(item.body)}\r\n`,
            )
            .join("");
          responseText = `${parts}--response_boundary--\r\n`;
        }
      } else if (
        url.searchParams.get("$deltatoken") === "expired" ||
        url.pathname.endsWith("/history")
      ) {
        expired++;
        status = provider === "outlook" ? 410 : 404;
      } else if (provider === "outlook") {
        if (url.pathname === "/v1.0/me/mailFolders") body = { value: [] };
        else if (url.searchParams.get("$deltatoken") === "fresh")
          body = {
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fresh",
          };
        else if (url.pathname.endsWith("/messages/delta") && url.pathname.includes("/inbox/")) {
          deltaUrls.push(url);
          body = {
            value: Array.from({ length: options.listed ?? 10 }, (_value, index) =>
              partial
                ? { id: `m${index}` }
                : {
                    id: `m${index}`,
                    conversationId: `m${index}`,
                    isRead: false,
                    receivedDateTime: new Date(options.now ?? 1000).toISOString(),
                  },
            ),
            ...(options.missingCheckpoint
              ? {}
              : {
                  "@odata.deltaLink":
                    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fresh",
                }),
          };
        } else if (url.pathname.match(/\/mailFolders\/(inbox|archive)$/))
          body = {
            id: url.pathname.endsWith("inbox") ? "folder-inbox" : "folder-archive",
            totalItemCount: url.pathname.endsWith("inbox") ? 28666 : 103,
            unreadItemCount: url.pathname.endsWith("inbox") ? 26042 : 0,
          };
        else status = 404;
      } else if (url.pathname.endsWith("/labels")) body = { labels: [] };
      else if (url.pathname.endsWith("/profile"))
        body = { historyId: "fresh", emailAddress: "me@example.test" };
      else if (url.pathname.endsWith("/messages"))
        body = { messages: Array.from({ length: 10 }, (_value, index) => ({ id: `m${index}` })) };
      else if (/\/messages\/m\d+$/.test(url.pathname)) {
        const id = url.pathname.split("/").at(-1);
        body = {
          id,
          threadId: id,
          internalDate: "1000",
          labelIds: ["INBOX", "UNREAD"],
          payload: { mimeType: "text/plain", body: { size: 0 } },
        };
      } else status = 404;
      return HttpClientResponse.fromWeb(
        request,
        new Response(responseText ?? (body === undefined ? null : JSON.stringify(body)), {
          status,
          headers,
        }),
      );
    }),
  );
  return {
    layer: Layer.succeed(HttpClient.HttpClient)(client),
    batches,
    deltaUrls,
    verifiedIds,
    expired: () => expired,
    batchCalls: () => batchCalls,
  };
}
function runtime<A, E>(
  provider: Provider,
  adapter: Effect.Effect<
    ProviderAdapter,
    never,
    | HttpClient.HttpClient
    | import("./services.js").Secrets
    | import("./services.js").AppConfig
    | import("./services.js").OAuthIssuers
    | import("./services.js").OAuth
    | import("./platform/mail-codec.js").MailCodec
  >,
  body: Effect.Effect<A, E, Store | Mailbox | Providers>,
  http: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make(() => Effect.die("Unexpected HTTP request")),
  ),
) {
  const platform = MemoryPlatform({
    secrets: { [`${provider}:me@example.test`]: "secret" },
    config: {
      microsoft: { clientId: "client" },
      google: { clientId: "client", clientSecret: "secret" },
    },
  });
  const services = Layer.mergeAll(
    StoreLive,
    Layer.effect(Providers, adapter.pipe(Effect.map((value) => ({ get: () => value })))),
  ).pipe(Layer.provideMerge(Layer.mergeAll(platform, http)));
  return body.pipe(
    Effect.provide(
      MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(Layer.provideMerge(services)),
    ),
  );
}

for (const provider of ["outlook", "gmail"] as const)
  for (const outcome of ["present", "gone", "moved", "deferred"] as const) {
    it.effect(`${provider} expired reset listing 10% verifies ${outcome} candidates`, () => {
      const http = httpProvider(provider, outcome);
      return runtime(
        provider,
        provider === "outlook" ? makeOutlook : makeGmail,
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount(provider, "me@example.test");
          for (let index = 0; index < 100; index++)
            yield* store.upsertMessage(account.id, mail(`m${index}`));
          yield* store.saveSyncCursor(
            account.id,
            provider === "gmail"
              ? "expired"
              : JSON.stringify({
                  __idType: "immutable",
                  inbox:
                    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired",
                }),
          );
          const result = yield* (yield* Mailbox).sync(account.id);
          assert.isUndefined(result[0]?.error);
          assert.strictEqual(http.expired(), 1);
          if (outcome === "deferred")
            assert.deepStrictEqual(yield* store.headerBackfillState(account.id), {
              kind: "running",
              after: null,
            });
          assert.deepStrictEqual(
            http.batches,
            outcome === "deferred" ? [20] : [20, 20, 20, 20, 10],
          );
          assert.strictEqual(
            yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
            outcome === "gone" ? 10 : 100,
          );
          if (outcome === "moved") {
            assert.isFalse((yield* store.getMessage(`${account.id}/m10`)).labels.includes("INBOX"));
            if (provider === "outlook")
              assert.include((yield* store.getMessage(`${account.id}/m10`)).labels, "ARCHIVE");
          }
          assert.strictEqual(
            (yield* store.pendingResetCandidates(account.id)).length,
            outcome === "deferred" ? 90 : 0,
          );
        }),
        http.layer,
      );
    });
  }

it.effect("a listed Graph id stays kept when the complete message GET returns 404", () => {
  const http = httpProvider("outlook", "gone", true);
  return runtime(
    "outlook",
    makeOutlook,
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "me@example.test");
      for (let index = 0; index < 100; index++)
        yield* store.upsertMessage(account.id, mail(`m${index}`));
      yield* store.saveSyncCursor(
        account.id,
        JSON.stringify({
          __idType: "immutable",
          inbox:
            "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired",
        }),
      );
      assert.isUndefined((yield* (yield* Mailbox).sync(account.id))[0]?.error);
      assert.strictEqual(
        yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
        10,
      );
      assert.strictEqual(
        (yield* store.getMessage(`${account.id}/m0`)).bodyText,
        "full cached body",
      );
      assert.strictEqual((yield* store.listPendingOps).length, 10);
    }),
    http.layer,
  );
});

it.effect("verification cap and persisted remainder continue on the next sync", () => {
  const server = fakeServer("me@example.test");
  const seen: number[] = [];
  let reset = true;
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(server),
    pull: () => {
      const changes = reset ? [{ _tag: "Reset", keep: [] } as const] : [];
      reset = false;
      return Stream.fromIterable([...changes, { _tag: "Cursor", cursor: "fresh" } as const]);
    },
    verifyResetCandidates: (_account, candidates) =>
      Effect.sync(() => {
        seen.push(candidates.length);
        return candidates.map((candidate) => ({ kind: "gone" as const, id: candidate.providerId }));
      }),
  };
  return runtime(
    "gmail",
    Effect.succeed(adapter),
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      for (let index = 0; index < 620; index++)
        yield* store.upsertMessage(account.id, mail(`m${index}`));
      const mailbox = yield* Mailbox;
      yield* mailbox.sync(account.id);
      assert.strictEqual(
        yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
        120,
      );
      assert.strictEqual((yield* store.pendingResetCandidates(account.id)).length, 120);
      yield* mailbox.sync(account.id);
      assert.strictEqual(
        yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
        0,
      );
      assert.deepStrictEqual(seen, [500, 120]);
    }),
  );
});

it.effect("Gmail reset respects its date window and failed verification retains rows", () => {
  const adapter = makeFakeProvider(fakeServer("me@example.test"));
  return runtime(
    "gmail",
    Effect.succeed(adapter),
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      for (let index = 0; index < 100; index++)
        yield* store.upsertMessage(account.id, mail(`m${index}`));
      yield* store.upsertMessage(account.id, { ...mail("older"), date: 0 });
      const counts = { changed: 0, deleted: 0 };
      const guard = makeResetGuard(store, adapter, account, counts, { remaining: 500 });
      yield* guard.reset({ _tag: "Reset", since: 1000, keep: [] });
      yield* guard.verify();
      assert.strictEqual(
        yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
        101,
      );
      assert.strictEqual((yield* store.pendingResetCandidates(account.id)).length, 100);
    }),
  );
});

it("Gmail multipart responses map by Content-ID rather than position", () => {
  assert.deepStrictEqual(
    parseGmailBatch(
      "--b\r\nContent-ID: <response-7>\r\n\r\nHTTP/1.1 404 Gone\r\nContent-Type: application/json\r\n\r\n{}\r\n--b--",
      "multipart/mixed; boundary=b",
    ),
    {
      responses: [
        { id: "7", status: 404, headers: { "content-type": "application/json" }, body: {} },
      ],
    },
  );
});

it.effect(
  "deferred location probes preserve newer local flags and account removal clears the queue",
  () => {
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.test")),
      verifyResetCandidates: (_account, candidates) =>
        Effect.succeed(
          candidates.map((candidate) => ({
            kind: "present" as const,
            id: candidate.providerId,
            providerId: candidate.providerId,
            labels: ["INBOX", "UNREAD"],
          })),
        ),
    };
    return runtime(
      "outlook",
      Effect.succeed(adapter),
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("outlook", "me@example.test");
        for (let index = 0; index < 100; index++)
          yield* store.upsertMessage(account.id, mail(`m${index}`));
        const guard = makeResetGuard(
          store,
          adapter,
          account,
          { changed: 0, deleted: 0 },
          { remaining: 500 },
        );
        yield* guard.reset({ _tag: "DeleteLabel", label: "INBOX", keep: [] });
        yield* store.setFlags(account.id, "m0", { isUnread: false, isStarred: true });
        yield* guard.verify();
        const retained = yield* store.getMessage(`${account.id}/m0`);
        assert.isFalse(retained.isUnread);
        assert.isTrue(retained.isStarred);
        assert.strictEqual(retained.bodyText, "full cached body");
        yield* guard.reset({ _tag: "DeleteLabel", label: "INBOX", keep: [] });
        assert.strictEqual((yield* store.pendingResetCandidates(account.id)).length, 100);
        yield* store.removeAccount(account.id);
        assert.strictEqual((yield* store.pendingResetCandidates(account.id)).length, 0);
      }),
    );
  },
);

for (const recovering of [true, false]) {
  it.effect(
    `evidence: Outlook 28,666 server rows and 1,199 window rows survive ${recovering ? "410 restart" : "initial sync"}`,
    () => {
      const now = Date.UTC(2026, 9, 3);
      const http = httpProvider("outlook", "present", false, { listed: 91, now });
      return runtime(
        "outlook",
        makeOutlook,
        Effect.gen(function* () {
          yield* TestClock.setTime(now);
          const store = yield* Store;
          const account = yield* store.upsertAccount("outlook", "me@example.test");
          for (let index = 0; index < 1199; index++)
            yield* store.upsertMessage(account.id, { ...mail(`m${index}`), date: now - 1000 });
          yield* store.upsertMessage(account.id, {
            ...mail("older-inbox"),
            date: Date.UTC(2020, 8, 1),
          });
          if (recovering)
            yield* store.saveSyncCursor(
              account.id,
              JSON.stringify({
                __idType: "immutable",
                inbox:
                  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired",
              }),
            );
          const mailbox = yield* Mailbox;
          const before = (yield* mailbox.syncHealth(account.id)).folders.find(
            (folder) => folder.scope === "INBOX",
          );
          assert.ok(before?.server.kind === "available");
          assert.strictEqual(before.server.total, 28666);
          assert.strictEqual(before.local.total, 1200);
          for (let round = 0; round < 3; round++) {
            assert.isUndefined((yield* mailbox.sync(account.id))[0]?.error);
            const health = (yield* mailbox.syncHealth(account.id)).folders.find(
              (folder) => folder.scope === "INBOX",
            );
            assert.ok(health);
            assert.strictEqual(health.local.total, 1200);
            assert.strictEqual(health.headerWindow?.days, 90);
            assert.strictEqual(health.headerWindow?.messageLimit, 5000);
          }
          assert.strictEqual(http.expired(), recovering ? 1 : 0);
          assert.strictEqual(http.verifiedIds.length, 1108);
          assert.isFalse(http.verifiedIds.includes("older-inbox"));
          assert.strictEqual(
            (yield* store.getMessage(`${account.id}/older-inbox`)).bodyText,
            "full cached body",
          );
          assert.strictEqual((yield* store.pendingResetCandidates(account.id)).length, 0);
          const initial = http.deltaUrls[0];
          assert.ok(initial);
          assert.strictEqual(
            initial.searchParams.get("$filter"),
            `receivedDateTime ge ${new Date(now - 90 * 86400000).toISOString()}`,
          );
          assert.strictEqual(initial.searchParams.get("$orderby"), "receivedDateTime desc");
        }),
        http.layer,
      );
    },
  );
}

it.effect("an early-ended Outlook window probes small gaps and retains its checkpoint", () => {
  const http = httpProvider("outlook", "present", false, { listed: 10, missingCheckpoint: true });
  return runtime(
    "outlook",
    makeOutlook,
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "me@example.test");
      for (let index = 0; index < 12; index++)
        yield* store.upsertMessage(account.id, mail(`m${index}`));
      const previous =
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired";
      yield* store.saveSyncCursor(
        account.id,
        JSON.stringify({ __idType: "immutable", inbox: previous }),
      );
      assert.isUndefined((yield* (yield* Mailbox).sync(account.id))[0]?.error);
      assert.strictEqual(
        yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
        12,
      );
      assert.deepStrictEqual(http.batches, [2]);
      const cursor = yield* store.getSyncCursor(account.id);
      const value =
        cursor._tag === "Some"
          ? Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Struct({ inbox: Schema.String })),
            )(cursor.value)
          : undefined;
      assert.strictEqual(value?.inbox, previous);
    }),
    http.layer,
  );
});

it.effect("a Graph delta reaching the filtered 5,000 cap remains a partial window", () => {
  const http = httpProvider("outlook", "present", false, { listed: 5000 });
  return makeOutlook.pipe(
    Effect.flatMap((adapter) =>
      Effect.gen(function* () {
        const account = {
          id: "outlook:me@example.test",
          provider: "outlook",
          email: "me@example.test",
          createdAt: 0,
          lastSyncedAt: null,
          lastSyncError: null,
          profileId: null,
          needsReauth: false,
        } as const;
        let listed = 0;
        let reset: Extract<import("./services.js").Change, { _tag: "Reset" }> | undefined;
        yield* Stream.runForEach(adapter.pull(account, Option.none()), (change) =>
          Effect.sync(() => {
            if (change._tag === "Upsert") listed++;
            if (change._tag === "Reset") reset = change;
          }),
        );
        assert.strictEqual(listed, 5000);
        assert.ok(reset);
        assert.strictEqual(reset.keep?.length, 5000);
        assert.isTrue(reset.partial);
        assert.isNumber(reset.since);
        assert.strictEqual(
          http.deltaUrls[0]?.searchParams.get("$orderby"),
          "receivedDateTime desc",
        );
      }),
    ),
    Effect.provide(
      Layer.mergeAll(
        http.layer,
        MemoryPlatform({
          secrets: { "outlook:me@example.test": "secret" },
          config: { microsoft: { clientId: "client" } },
        }),
      ),
    ),
  );
});

for (const provider of ["gmail", "outlook"] as const) {
  it.effect(
    `${provider} stale verification respects batch Retry-After and the hourly cooldown`,
    () => {
      const http = httpProvider(provider, "deferred");
      return runtime(
        provider,
        provider === "gmail" ? makeGmail : makeOutlook,
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount(provider, "me@example.test");
          for (let n = 0; n < 21; n++) yield* store.upsertMessage(account.id, mail(`m${n}`));
          const adapter = (yield* Providers).get(provider);
          const health = () =>
            Effect.succeed({
              provider,
              accountDomainHash: "hash",
              checkedAt: 0,
              cursorAgeMs: null,
              pendingOps: 0,
              folders: [
                {
                  scope: "INBOX",
                  local: { total: 21, unread: 21, threads: 21 },
                  server: {
                    kind: "available" as const,
                    total: 0,
                    unread: 0,
                    threads: null,
                    uidNext: null,
                    uidValidity: null,
                  },
                  bodyCacheWindowDays: null,
                  headerWindow: null,
                  cursorAgeMs: null,
                  pendingOps: 0,
                  verdict: "local has more — stale" as const,
                },
              ],
            });
          const guard = makeResetGuard(
            store,
            adapter,
            account,
            { changed: 0, deleted: 0 },
            { remaining: 500 },
          );
          yield* guard.sweep(health);
          assert.deepStrictEqual(http.batches, [20]);
          // Retry-After 120 exceeds the request's 60-second wait budget: defer,
          // and do not immediately send another request or remove the cached row.
          assert.strictEqual(
            yield* store.messageIdForProvider(account.id, "m1"),
            `${account.id}/m1`,
          );
          yield* guard.sweep(health);
          assert.deepStrictEqual(http.batches, [20]);
          yield* TestClock.adjust("1 hour");
          yield* guard.sweep(health);
          // A new sync gets a new verification guard; no duplicate probes within one run.
          const next = makeResetGuard(
            store,
            adapter,
            account,
            { changed: 0, deleted: 0 },
            { remaining: 500 },
          );
          yield* TestClock.adjust("1 hour");
          yield* next.sweep(health);
          assert.deepStrictEqual(http.batches, [20, 20]);
          assert.strictEqual(
            yield* store.messageIdForProvider(account.id, "m1"),
            `${account.id}/m1`,
          );
        }),
        http.layer,
      );
    },
  );
}

for (const provider of ["gmail", "outlook"] as const) {
  for (const status of [400, 401, 403]) {
    it.effect(`${provider} sweep inner ${status} keeps cached rows`, () => {
      const http = httpProvider(provider, "present", false, { verificationStatus: status });
      return runtime(
        provider,
        provider === "gmail" ? makeGmail : makeOutlook,
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount(provider, "me@example.test");
          yield* store.upsertMessage(account.id, mail("m1"));
          const budget = { remaining: 500 };
          const guard = makeResetGuard(
            store,
            (yield* Providers).get(provider),
            account,
            { changed: 0, deleted: 0 },
            budget,
          );
          yield* guard.sweep(() =>
            Effect.succeed({
              provider,
              accountDomainHash: "hash",
              checkedAt: 0,
              cursorAgeMs: null,
              pendingOps: 0,
              folders: [
                {
                  scope: "INBOX",
                  local: { total: 1, unread: 1, threads: 1 },
                  server: {
                    kind: "available" as const,
                    total: 0,
                    unread: 0,
                    threads: null,
                    uidNext: null,
                    uidValidity: null,
                  },
                  bodyCacheWindowDays: null,
                  headerWindow: null,
                  cursorAgeMs: null,
                  pendingOps: 0,
                  verdict: "local has more — stale" as const,
                },
              ],
            }),
          );
          assert.strictEqual(
            (yield* store.getMessage(`${account.id}/m1`)).bodyText,
            "full cached body",
          );
          assert.deepStrictEqual(http.batches, [1]);
          assert.strictEqual(budget.remaining, 500);
        }),
        http.layer,
      );
    });
  }
}

it.effect("Gmail verification 200 without labelIds reports a present unlabeled message", () => {
  const http = httpProvider("gmail", "present", false, { omitLabels: true });
  return runtime(
    "gmail",
    makeGmail,
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      const adapter = (yield* Providers).get("gmail");
      assert.ok(typeof adapter.verifyResetCandidates === "function");
      const result = yield* adapter.verifyResetCandidates(account, [
        { providerId: "m1", rfcMessageId: null, labels: ["CATEGORY_PERSONAL"] },
      ]);
      assert.deepStrictEqual(result, [{ kind: "present", id: "m1", providerId: "m1", labels: [] }]);
    }),
    http.layer,
  );
});

for (const kind of ["Reset", "DeleteLabel", "RebuildFolder"] as const) {
  it.effect(`a single missing row in ${kind} is verified before deletion`, () => {
    const verified: string[] = [];
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.test")),
      verifyResetCandidates: (_account, candidates) =>
        Effect.sync(() => {
          verified.push(...candidates.map((candidate) => candidate.providerId));
          return candidates.map((candidate) => ({
            kind: "present" as const,
            id: candidate.providerId,
            providerId: candidate.providerId,
            labels: candidate.labels,
          }));
        }),
    };
    return runtime(
      "imap",
      Effect.succeed(adapter),
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("imap", "me@example.test");
        yield* store.upsertMessage(account.id, mail("7:1:INBOX"));
        const counts = { changed: 0, deleted: 0 };
        const guard = makeResetGuard(store, adapter, account, counts, { remaining: 500 });
        yield* guard.reset(
          kind === "Reset"
            ? { _tag: "Reset", keep: [] }
            : kind === "DeleteLabel"
              ? { _tag: "DeleteLabel", label: "INBOX" }
              : { _tag: "RebuildFolder", previous: { path: "INBOX", uidValidity: "7" }, keep: [] },
        );
        assert.strictEqual(counts.deleted, 0);
        assert.strictEqual((yield* store.pendingResetCandidates(account.id)).length, 1);
        yield* guard.verify();
        assert.deepStrictEqual(verified, ["7:1:INBOX"]);
        assert.strictEqual(
          (yield* store.getMessage(`${account.id}/7:1:INBOX`)).bodyText,
          "full cached body",
        );
      }),
    );
  });
}

it.effect("Gmail recovery verifies a single missing message at the 90-day window edge", () => {
  const now = 100 * 86400000;
  const http = httpProvider("gmail", "present", false, { now });
  return runtime(
    "gmail",
    makeGmail,
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      for (let index = 0; index < 10; index++)
        yield* store.upsertMessage(account.id, { ...mail(`m${index}`), date: now });
      yield* store.upsertMessage(account.id, { ...mail("edge"), date: now - 90 * 86400000 + 1 });
      yield* store.saveSyncCursor(account.id, "expired");
      yield* (yield* Mailbox).sync(account.id);
      assert.deepStrictEqual(http.verifiedIds, ["edge"]);
      assert.strictEqual(
        (yield* store.getMessage(`${account.id}/edge`)).bodyText,
        "full cached body",
      );
    }),
    http.layer,
  );
});

it.effect("verification keeps candidates queued while its provider request was in flight", () => {
  let queueLate: Effect.Effect<void> = Effect.void;
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(fakeServer("me@example.test")),
    verifyResetCandidates: (_account, candidates) =>
      queueLate.pipe(
        Effect.as(
          candidates
            .filter((candidate) => candidate.providerId === "m0")
            .map((candidate) => ({ kind: "gone" as const, id: candidate.providerId })),
        ),
      ),
  };
  return runtime(
    "gmail",
    Effect.succeed(adapter),
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      for (const id of ["m0", "m1", "late"]) yield* store.upsertMessage(account.id, mail(id));
      const guard = makeResetGuard(
        store,
        adapter,
        account,
        { changed: 0, deleted: 0 },
        { remaining: 500 },
      );
      yield* guard.enqueue(["m0", "m1"]);
      // Another writer queues a candidate between the read and the write.
      queueLate = guard.enqueue(["late"]);
      yield* guard.verify();
      assert.deepStrictEqual(
        (yield* store.pendingResetCandidates(account.id)).map((c) => c.providerId).toSorted(),
        ["late", "m1"],
      );
    }),
  );
});
