import { createServer } from "node:net";
import { NodeCrypto } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { MailError } from "../domain/errors.js";
import { makeGmail } from "./gmail/gmail.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { makeOutlook } from "./outlook/outlook.js";
import {
  fakeHttp,
  graphFolderRoutes,
  type FakeHttpCall,
  type FakeHttpReply,
} from "../platform/node/fake-http.js";
import { failure, openImap } from "../platform/node/imap/session.js";
import { OAuthLoopback } from "../platform/node/oauth.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { account as buildAccount, incoming, outgoing } from "../platform/node/testing.js";
import { transferAllowance } from "./provider-http.js";
import { isDefiniteSendFailure } from "./provider-send.js";
import { Browser, OAuth, Providers, Store, type ProviderAdapter } from "../services.js";
import { StoreLive } from "../store/store.js";
import { SYNC_FAILURE_TEXT } from "../sync/sync-failure.js";

type Fault = NonNullable<FakeHttpReply["fault"]>;
type Route = FakeHttpReply | ((url: URL, call: FakeHttpCall) => FakeHttpReply);
/** DNS failure stands for refused and reset connections too: all fail before a response. */
const FAULTS: readonly Fault[] = ["ENOTFOUND", "reset-body", "stall-headers", "stall-body"];
const GRAPH = "https://graph.microsoft.com/v1.0";

const providers = {
  gmail: {
    make: makeGmail,
    account: buildAccount("gmail"),
    platform: { google: { clientId: "client", clientSecret: "secret" } },
  },
  outlook: {
    make: makeOutlook,
    account: buildAccount("outlook"),
    platform: { microsoft: { clientId: "client" } },
  },
} as const;
type Provider = keyof typeof providers;

/** Fake routes plus the in-memory keychain and OAuth client for `provider`. */
function platformLayer(provider: Provider, routes: Record<string, Route>) {
  const http = fakeHttp(routes);
  const { account, platform } = providers[provider];
  return {
    http,
    layer: Layer.mergeAll(
      http.layer,
      MemoryPlatform({ secrets: { [account.id]: "refresh" }, config: platform }),
    ),
  };
}

/** A Mailbox over an in-memory store and the real adapter for `provider`. */
function mailboxServices(provider: Provider, routes: Record<string, Route>) {
  const { http, layer } = platformLayer(provider, routes);
  const adapter = Layer.effect(
    Providers,
    providers[provider].make.pipe(Effect.map((made) => ({ get: () => made }))),
  );
  return {
    http,
    layer: MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
      Layer.provideMerge(Layer.mergeAll(StoreLive, adapter).pipe(Layer.provideMerge(layer))),
    ),
  };
}

/** Every operation sends its first requests through `routes`; `target` is the request that breaks. */
const operations: Record<
  "gmail" | "outlook",
  Record<
    string,
    {
      routes: Record<string, Route>;
      target: string;
      run: (adapter: ProviderAdapter) => Effect.Effect<unknown, unknown>;
    }
  >
> = {
  gmail: {
    "initial pull": {
      routes: {},
      target: "GET /labels",
      run: (a) => Stream.runDrain(a.pull(providers.gmail.account, Option.none())),
    },
    "history page continuation": {
      routes: {
        "GET /labels": { json: { labels: [] } },
        "GET /messages/m1": { json: gmailMessage("m1") },
      },
      target: "GET /history",
      run: (a) => Stream.runDrain(a.pull(providers.gmail.account, Option.some("100"))),
    },
    "body fetch": {
      routes: {},
      target: "GET /messages/m1",
      run: (a) => a.fetchMessage(providers.gmail.account, "m1"),
    },
    "attachment download": {
      routes: {
        "GET /messages/m1": {
          json: {
            ...gmailMessage("m1"),
            payload: {
              mimeType: "multipart/mixed",
              headers: [],
              body: { size: 0 },
              parts: [
                {
                  mimeType: "application/pdf",
                  filename: "a.pdf",
                  headers: [],
                  body: { size: 9, attachmentId: "att" },
                },
              ],
            },
          },
        },
      },
      target: "GET /messages/m1/attachments/att",
      run: (a) =>
        a.fetchAttachment(providers.gmail.account, "m1", {
          index: 0,
          filename: "a.pdf",
          occurrence: 0,
        }),
    },
    "archive push": {
      routes: {},
      target: "POST /messages/m1/modify",
      run: (a) => a.push(providers.gmail.account, "m1", { kind: "archive" }),
    },
  },
  outlook: {
    "initial pull": {
      routes: { "GET /me/mailFolders": { json: { value: [] } } },
      target: "GET /me/mailFolders/inbox",
      run: (a) => Stream.runDrain(a.pull(providers.outlook.account, Option.none())),
    },
    "delta page continuation": {
      routes: {
        "GET /me/mailFolders": { json: { value: [] } },
        ...graphFolderRoutes({}),
      },
      target: "GET /me/mailFolders/inbox/messages/delta",
      run: (a) => Stream.runDrain(a.pull(providers.outlook.account, Option.none())),
    },
    "body fetch": {
      routes: {},
      target: "GET /me/messages/m1",
      run: (a) => a.fetchMessage(providers.outlook.account, "m1"),
    },
    "attachment download": {
      routes: {
        "GET /me/messages/m1/attachments": {
          json: { value: [{ id: "att", name: "a.pdf", isInline: false }] },
        },
      },
      target: "GET /me/messages/m1/attachments/att/$value",
      run: (a) =>
        a.fetchAttachment(providers.outlook.account, "m1", {
          index: 0,
          filename: "a.pdf",
          occurrence: 0,
        }),
    },
    "archive push": {
      routes: {},
      target: "POST /me/messages/m1/move",
      run: (a) => a.push(providers.outlook.account, "m1", { kind: "archive" }),
    },
    "read push": {
      routes: {},
      target: "PATCH /me/messages/m1",
      run: (a) => a.push(providers.outlook.account, "m1", { kind: "read", value: true }),
    },
  },
};

function gmailMessage(id: string) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX"],
    snippet: "",
    internalDate: "1700000000000",
    payload: { mimeType: "text/plain", headers: [], body: { size: 0, data: "" } },
  };
}

/** Only the continuation page breaks: the first page leads to it. */
function withContinuation(fault: Fault): Record<string, Route> {
  return {
    "GET /history": (url) => {
      if (url.searchParams.has("pageToken")) return { fault, json: { historyId: "150" } };
      return {
        json: {
          historyId: "150",
          history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
          nextPageToken: "two",
        },
      };
    },
    "GET /me/mailFolders/inbox/messages/delta": (url) => {
      if (url.searchParams.has("$skiptoken")) return { fault, json: { value: [] } };
      return {
        json: {
          value: [],
          "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=2`,
        },
      };
    },
  };
}

/** Advances in 1 s steps until the fiber ends; returns its exit and the virtual time it took. */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>, limit = 10 * 60_000) =>
  Effect.gen(function* () {
    let waited = 0;
    while (fiber.pollUnsafe() === undefined && waited < limit) {
      yield* TestClock.adjust("1 second");
      waited += 1000;
    }
    const exit = fiber.pollUnsafe();
    if (!exit) return assert.fail(`The request was still waiting after ${limit / 1000} s`);
    return { exit, waited };
  });

/** The typed error an exit failed with, if any. */
function failureOf(exit: Exit.Exit<unknown, unknown>): MailError | undefined {
  if (exit._tag === "Success") return undefined;
  for (const reason of exit.cause.reasons)
    if (reason._tag === "Fail" && Schema.is(MailError)(reason.error)) return reason.error;
  return undefined;
}

/** Offline means a retryable ProviderError with status 0, never a sign-in problem. */
function assertOffline(error: MailError | undefined, trace = "") {
  assert.strictEqual(error?._tag, "ProviderError", trace);
  if (error?._tag === "ProviderError") assert.strictEqual(error.status, 0, trace);
}

const isSubmission = (call: FakeHttpCall) => /\/(?:send|sendMail)$/.test(call.url.pathname);

/** The Message-ID the adapter put in the submitted MIME or JSON. */
function submitted(calls: readonly FakeHttpCall[]) {
  const body = JSON.stringify(calls.find(isSubmission)?.body ?? "");
  const raw = /"raw":"([^"]+)"/.exec(body)?.[1];
  const text = raw ? Buffer.from(raw, "base64url").toString() : body;
  return /Message-ID: (<[^>]+>)/i.exec(text)?.[1];
}

/** Sent lookups for Gmail and Graph; `delivered` decides whether the copy is there. */
const sentRoutes = (calls: () => readonly FakeHttpCall[], delivered: boolean) => ({
  "GET /messages": (url: URL) => ({
    json:
      delivered && /<[^>]+>/.test(url.searchParams.get("q") ?? "")
        ? { messages: [{ id: "sent" }] }
        : {},
  }),
  "GET /messages/sent": () => ({
    json: {
      id: "sent",
      payload: { headers: [{ name: "Message-ID", value: submitted(calls()) ?? "" }] },
    },
  }),
  "GET /me/mailFolders/sentitems/messages": () => ({
    json: { value: delivered ? [{ id: "sent" }] : [] },
  }),
});

for (const provider of ["gmail", "outlook"] as const) {
  const { make, account } = providers[provider];
  for (const [name, operation] of Object.entries(operations[provider]))
    for (const fault of FAULTS)
      it.effect(`${provider} ${name}: ${fault} fails within the stall bound as offline`, () =>
        Effect.gen(function* () {
          const continuation = name.includes("continuation");
          const { http, layer } = platformLayer(provider, {
            ...operation.routes,
            ...(continuation
              ? withContinuation(fault)
              : { [operation.target]: { fault, json: {} } }),
          });
          const { exit, waited } = yield* make.pipe(
            Effect.flatMap((adapter) => operation.run(adapter).pipe(Effect.forkChild)),
            Effect.flatMap((fiber) => settle(fiber)),
            Effect.provide(layer),
          );
          const trace = JSON.stringify(http.calls.map((call) => call.route));
          assertOffline(failureOf(exit), trace);
          // Two 60 s stall windows and the 0.5 s backoff; each timer can cost one more 1 s step.
          assert.isAtMost(waited, 130_000, trace);
          const target = http.calls.filter((call) => call.route === operation.target);
          // Reads retry a transport failure once; writes are never replayed after one.
          assert.strictEqual(
            target.length - (continuation ? 1 : 0),
            operation.target.startsWith("GET") ? 2 : 1,
          );
        }),
      );

  it.effect(`${provider} send: a DNS failure is a definite failure with no Sent lookup`, () =>
    Effect.gen(function* () {
      const { http, layer } = platformLayer(provider, {
        "POST /messages/send": { fault: "ENOTFOUND" },
        "POST /me/sendMail": { fault: "ENOTFOUND" },
      });
      const error = yield* make.pipe(
        Effect.flatMap((adapter) => Effect.flip(adapter.send(account, outgoing(), Option.none()))),
        Effect.provide(layer),
      );
      assert.strictEqual(error._tag, "ProviderError");
      assert.isTrue(isDefiniteSendFailure(error));
      assert.strictEqual(http.calls.length, 1);
    }),
  );

  it.effect(
    `${provider} send: a 2xx reply that is not JSON is SendUncertain without a second POST`,
    () =>
      Effect.gen(function* () {
        // A captive portal or proxy can answer 200 with HTML after the request reached the provider.
        const html = {
          status: 200,
          text: "<html>proxy</html>",
          headers: { "content-type": "text/html" },
        };
        const { http, layer } = platformLayer(provider, {
          "POST /messages/send": html,
          "POST /me/sendMail": html,
          ...sentRoutes(() => http.calls, false),
        });
        const { exit } = yield* make.pipe(
          Effect.flatMap((adapter) =>
            adapter.send(account, outgoing(), Option.none()).pipe(Effect.forkChild),
          ),
          Effect.flatMap((fiber) => settle(fiber)),
          Effect.provide(layer),
        );
        assert.strictEqual(http.calls.filter(isSubmission).length, 1);
        assert.strictEqual(failureOf(exit)?._tag, "SendUncertain");
      }),
  );

  for (const fault of ["ECONNRESET", "reset-body", "stall-headers", "stall-body"] as const)
    for (const delivered of [true, false])
      it.effect(
        `${provider} send: ${fault} after submission ${delivered ? "finds the Sent copy" : "is SendUncertain"} without a second POST`,
        () =>
          Effect.gen(function* () {
            const { http, layer } = platformLayer(provider, {
              "POST /messages/send": { fault, json: { id: "sent" } },
              "POST /me/sendMail": { fault, status: 202 },
              ...sentRoutes(() => http.calls, delivered),
            });
            const { exit } = yield* make.pipe(
              Effect.flatMap((adapter) =>
                adapter.send(account, outgoing(), Option.none()).pipe(Effect.forkChild),
              ),
              Effect.flatMap((fiber) => settle(fiber)),
              Effect.provide(layer),
            );
            assert.strictEqual(http.calls.filter(isSubmission).length, 1);
            if (delivered) assert.strictEqual(exit._tag, "Success");
            else assert.strictEqual(failureOf(exit)?._tag, "SendUncertain");
          }),
      );
}

// 10 MB of attachment is about 13.3 MB of base64 JSON: 107 s at 1 Mbps, longer than one stall window.
const UPLOAD_BYTES_PER_MS = 125;
const large = outgoing({
  attachments: [
    {
      filename: "large.bin",
      mimeType: "application/octet-stream",
      content: Buffer.alloc(10 * 1024 * 1024).toString("base64"),
    },
  ],
});
for (const stall of [false, true])
  it.effect(
    stall
      ? "gmail send: a stall after a slow upload finishes times out into the Sent check"
      : "gmail send: a slow upload that keeps making progress succeeds",
    () =>
      Effect.gen(function* () {
        let uploaded = 0;
        const { http, layer } = platformLayer("gmail", {
          "POST /messages/send": (_url, call) => {
            uploaded = JSON.stringify(call.body).length;
            const delay = uploaded / UPLOAD_BYTES_PER_MS;
            return stall ? { delay, fault: "stall-headers" } : { delay, json: { id: "sent" } };
          },
          ...sentRoutes(() => http.calls, false),
        });
        const { exit, waited } = yield* makeGmail.pipe(
          Effect.flatMap((adapter) =>
            adapter.send(providers.gmail.account, large, Option.none()).pipe(Effect.forkChild),
          ),
          Effect.flatMap((fiber) => settle(fiber, 30 * 60_000)),
          Effect.provide(layer),
        );
        assert.strictEqual(http.calls.filter(isSubmission).length, 1);
        if (!stall) {
          assert.strictEqual(exit._tag, "Success");
          return;
        }
        assert.strictEqual(failureOf(exit)?._tag, "SendUncertain");
        assert.isAbove(waited, uploaded / UPLOAD_BYTES_PER_MS);
        // The header wait plus its upload allowance, then about 30 s of Sent lookups.
        assert.isAtMost(waited, 60_000 + transferAllowance(uploaded) + 40_000);
      }),
  );

it.effect("a stalled token endpoint fails as offline instead of holding the refresh lock", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /token": { fault: "stall-headers" } });
    const oauth = OAuthLoopback.pipe(
      Layer.provide([
        Layer.succeed(Browser, Browser.of({ open: () => Effect.void })),
        http.layer,
        NodeCrypto.layer,
      ]),
    );
    const { exit, waited } = yield* Effect.gen(function* () {
      const fiber = yield* (yield* OAuth)
        .refresh("gmail:me@gmail.com", {
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client",
          refreshToken: "refresh",
        })
        .pipe(Effect.forkChild);
      return yield* settle(fiber);
    }).pipe(Effect.provide(oauth));
    assert.isAtMost(waited, 60_000);
    assertOffline(failureOf(exit));
  }),
);

const graphMessage = (id: string) => ({
  id,
  conversationId: `t-${id}`,
  subject: id,
  from: { emailAddress: { name: "", address: "a@example.test" } },
  toRecipients: [],
  ccRecipients: [],
  receivedDateTime: new Date(1_700_000_000_000).toISOString(),
  bodyPreview: id,
  body: { contentType: "text", content: id },
  isRead: true,
  isDraft: false,
  hasAttachments: false,
  parentFolderId: "id-inbox",
  flag: { flagStatus: "notFlagged" },
});

for (const fault of ["ENOTFOUND", "reset-body", "stall-body"] as const)
  it.effect(
    `outlook sync after ${fault} on a delta continuation resumes from the saved cursor with each message once`,
    () => {
      let broken = true;
      const done = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=done`;
      const { http, layer } = mailboxServices("outlook", {
        "GET /me/mailFolders": { json: { value: [] } },
        ...graphFolderRoutes({
          inbox: (url) => {
            if (url.searchParams.get("$deltatoken") === "done")
              return { json: { value: [], "@odata.deltaLink": done } };
            if (url.searchParams.has("$skiptoken"))
              return {
                ...(broken ? { fault } : {}),
                json: { value: [graphMessage("m2")], "@odata.deltaLink": done },
              };
            return {
              json: {
                value: [graphMessage("m1")],
                "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=2`,
              },
            };
          },
        }),
      });
      const continuations = () =>
        http.calls.filter((call) => call.url.searchParams.has("$skiptoken")).length;
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", providers.outlook.account.email);
        const failed = yield* settle(yield* mailbox.sync().pipe(Effect.forkChild));
        assert.strictEqual(failed.exit._tag, "Success");
        const offline = yield* store.getAccount(saved.id);
        assert.isFalse(offline.needsReauth);
        assert.strictEqual(offline.lastSyncError, SYNC_FAILURE_TEXT.network);
        // A second sync while the account backs off sends nothing.
        const pages = continuations();
        yield* mailbox.sync();
        assert.strictEqual(continuations(), pages);
        broken = false;
        yield* mailbox.resetConnectivity();
        yield* mailbox.sync();
        const online = yield* store.getAccount(saved.id);
        assert.isNull(online.lastSyncError);
        assert.isFalse(online.needsReauth);
        assert.isNotNull(yield* store.messageIdForProvider(saved.id, "m1"));
        assert.isNotNull(yield* store.messageIdForProvider(saved.id, "m2"));
        assert.strictEqual(yield* store.countThreads({ accountIds: [saved.id] }), 2);
      }).pipe(Effect.provide(layer));
    },
  );

const actor = { kind: "user", surface: "app" } as const;

it.effect("queued ops wait out an outage in order and retry at once on reconnect", () => {
  let offline = true;
  const { http, layer } = mailboxServices("gmail", {
    "POST /messages/one/modify": () => (offline ? { fault: "ENOTFOUND" } : { json: {} }),
  });
  const pushes = () => http.calls.filter((call) => call.method === "POST");
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    const saved = yield* store.upsertAccount("gmail", providers.gmail.account.email);
    yield* store.upsertMessage(saved.id, incoming("one", { labels: ["INBOX", "UNREAD"] }));
    const thread = `${saved.id}/one`;
    yield* mailbox.perform(
      { kind: "modify", threads: [thread], op: { kind: "read", value: true } },
      actor,
    );
    yield* mailbox.perform({ kind: "modify", threads: [thread], op: { kind: "archive" } }, actor);
    assert.deepStrictEqual(
      (yield* store.listPendingOps).map((op) => op.op.kind),
      ["read", "archive"],
    );
    assert.strictEqual(pushes().length, 1);
    // Five offline minutes of sync ticks cost a handful of attempts, not a tight loop.
    for (let tick = 0; tick < 60; tick++) {
      yield* TestClock.adjust("5 seconds");
      yield* mailbox.sync();
    }
    assert.isAtMost(pushes().length, 7);
    assert.isFalse((yield* store.getAccount(saved.id)).needsReauth);
    offline = false;
    const before = pushes().length;
    yield* mailbox.resetConnectivity();
    yield* mailbox.sync();
    assert.deepStrictEqual(yield* store.listPendingOps, []);
    const replay = pushes()
      .slice(before)
      .map((call) => JSON.stringify(call.body));
    assert.strictEqual(replay.length, 2);
    assert.include(replay[0], "UNREAD");
    assert.include(replay[1], "INBOX");
  }).pipe(Effect.provide(layer));
});

it.effect("a reconnect leaves an op that backs off after a 429 waiting", () => {
  const { http, layer } = mailboxServices("gmail", {
    // Retry-After beyond the 60 s request budget fails the push at once.
    "POST /messages/one/modify": { status: 429, headers: { "retry-after": "120" } },
  });
  const pushes = () => http.calls.filter((call) => call.method === "POST").length;
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    const saved = yield* store.upsertAccount("gmail", providers.gmail.account.email);
    yield* store.upsertMessage(saved.id, incoming("one", { labels: ["INBOX"] }));
    yield* mailbox.perform(
      { kind: "modify", threads: [`${saved.id}/one`], op: { kind: "archive" } },
      actor,
    );
    assert.strictEqual(pushes(), 1);
    const [waiting] = yield* store.listPendingOps;
    yield* mailbox.resetConnectivity();
    yield* mailbox.sync();
    assert.strictEqual(pushes(), 1);
    assert.strictEqual((yield* store.listPendingOps)[0]?.retryAt, waiting?.retryAt);
  }).pipe(Effect.provide(layer));
});

it("IMAP and SMTP network errors stay retryable and never ask for a new sign-in", () => {
  for (const [code, message] of [
    ["ENOTFOUND", "getaddrinfo ENOTFOUND imap.example.test"],
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:993"],
    [
      "ECONNRESET",
      "Client network socket disconnected before secure TLS connection was established",
    ],
    ["ETIMEOUT", "Socket timeout"],
  ] as const) {
    const error = failure(
      "imap:me",
      "imap.example.test",
      Object.assign(new Error(message), { code }),
    );
    assert.strictEqual(error._tag, "ProviderError");
    assert.notInclude(error.message, "TLS is required");
  }
  // A real STARTTLS refusal keeps its explanation.
  assert.include(
    failure("imap:me", "imap.example.test", new Error("Server does not support STARTTLS")).message,
    "TLS is required",
  );
});

it.live("a refused IMAP connection is a retryable provider error", () =>
  Effect.gen(function* () {
    const port = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) => {
          const server = createServer();
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
          });
        }),
    );
    const error = yield* openImap(
      "imap:me@example.test",
      {
        preset: "custom",
        username: "me",
        imapHost: "127.0.0.1",
        imapPort: port,
        smtpHost: "127.0.0.1",
        smtpPort: port,
        smtpSecure: false,
      },
      "password",
    ).pipe(Effect.scoped, Effect.flip);
    assert.strictEqual(error._tag, "ProviderError");
  }),
);
