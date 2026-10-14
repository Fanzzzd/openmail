import { assert, it } from "@effect/vitest";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { makeOutlook } from "./outlook.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { Providers } from "../adapter.js";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";
import {
  GRAPH,
  account,
  platformOptions,
  run,
  raw,
  mailbox,
  draftMessage,
  paths,
} from "../../../test-support/outlook-fixtures.js";
it.live("Outlook can retry draft creation after a connect failure without a lookup", () =>
  Effect.gen(function* () {
    let attempted = false;
    let posts = 0;
    let lookups = 0;
    const client = HttpClient.make((request) =>
      Effect.suspend(() => {
        if (request.method === "POST") {
          posts++;
          if (posts === 1)
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
                }),
              }),
            );
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ id: "draft" }))),
          );
        }
        lookups++;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
      }),
    );
    yield* run({ layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] }, (adapter) =>
      Effect.gen(function* () {
        const push = {
          remote: null,
          message: { ...draftMessage, attachments: [] },
          original: Option.none(),
          replaceAttachments: false,
          creation: {
            missing: () => Effect.succeed(false),
            begin: () => Effect.succeed({ messageId: "<connect@example.test>", attempted }),
            attempted: (_id: string, value = true) =>
              Effect.sync(() => {
                attempted = value;
              }),
            remember: () => Effect.void,
          },
        };
        const first = yield* adapter.saveDraft(account, push).pipe(Effect.result);
        assert.strictEqual(
          first._tag === "Failure" &&
            first.failure._tag === "ProviderError" &&
            first.failure.reason,
          "connection",
        );
        assert.isFalse(attempted);
        assert.strictEqual((yield* adapter.saveDraft(account, push)).draftId, "draft");
      }),
    );
    assert.strictEqual(posts, 2);
    assert.strictEqual(lookups, 0);
  }),
);

it.live("Outlook recreates a draft after the creation journal expires", () =>
  Effect.gen(function* () {
    let misses = 0;
    const http = fakeHttp({
      "GET /me/mailFolders/drafts/messages": { json: { value: [] } },
      "POST /me/messages": { json: { id: "retry-draft" } },
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const push = {
          remote: null,
          message: { ...draftMessage, attachments: [] },
          original: Option.none(),
          replaceAttachments: false,
          creation: {
            begin: () => Effect.succeed({ messageId: "<client@example.test>", attempted: true }),
            attempted: () => Effect.void,
            missing: () => Effect.sync(() => ++misses >= 3),
            remember: () => Effect.void,
          },
        };
        for (let i = 0; i < 2; i++) {
          const result = yield* adapter.saveDraft(account, push).pipe(Effect.result);
          assert.strictEqual(result._tag === "Failure" && result.failure._tag, "ProviderError");
          assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 0);
        }
        assert.strictEqual((yield* adapter.saveDraft(account, push)).draftId, "retry-draft");
      }),
    );
    assert.strictEqual(misses, 3);
    assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 1);
  }),
);

it.live("retry after the second attachment fails keeps one Outlook draft", () =>
  Effect.gen(function* () {
    let version = 1;
    let uploads = 0;
    let remembered = { draftId: "draft", messageId: "draft", changeKey: "k1", lastWrittenAt: 1000 };
    const metadata = () => ({
      id: "draft",
      changeKey: `k${version}`,
      lastModifiedDateTime: new Date(version * 1000).toISOString(),
    });
    const http = fakeHttp({
      "GET /me/messages/draft": () => ({ json: metadata() }),
      "PATCH /me/messages/draft": () => {
        version++;
        return { json: metadata() };
      },
      "GET /me/messages/draft/attachments": () => ({
        json: { value: uploads ? [{ id: "a", name: "a.txt", contentBytes: "aGk=" }] : [] },
      }),
      "DELETE /me/messages/draft/attachments/a": { status: 204 },
      "POST /me/messages/draft/attachments": () => {
        uploads++;
        if (uploads === 2) return { status: 503 };
        version++;
        return { json: {} };
      },
      "POST /me/messages": { json: { id: "duplicate" } },
    });
    const message = {
      ...draftMessage,
      attachments: [
        ...draftMessage.attachments,
        { filename: "b.txt", mimeType: "text/plain", content: "Yg==" },
      ],
    };
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const creation = {
          missing: () => Effect.succeed(false),
          begin: () => Effect.succeed({ messageId: "<client@example.test>", attempted: false }),
          attempted: () => Effect.void,
          remember: (remote: import("../../domain/changes.js").DraftRemote) =>
            Effect.sync(() => {
              remembered = {
                draftId: remote.draftId ?? "draft",
                messageId: remote.messageId ?? "draft",
                changeKey: remote.changeKey ?? "",
                lastWrittenAt: remote.lastWrittenAt ?? 1000,
              };
            }),
        };
        const first = yield* adapter
          .saveDraft(account, {
            remote: remembered,
            message,
            original: Option.none(),
            replaceAttachments: true,
            creation,
          })
          .pipe(Effect.result);
        const remote = first._tag === "Success" ? first.success : remembered;
        assert.strictEqual(first._tag, "Success");
        assert.strictEqual(
          first._tag === "Success" &&
            first.success.saveError?._tag === "ProviderError" &&
            first.success.saveError.status,
          503,
        );
        const retry = yield* adapter.saveDraft(account, {
          remote,
          message,
          original: Option.none(),
          replaceAttachments: true,
          creation,
        });
        assert.isNotTrue(retry.conflict);
        assert.strictEqual(retry.messageId, "draft");
      }),
    );
    assert.strictEqual(
      http.calls.filter(
        (call) => call.method === "POST" && call.url.pathname.endsWith("/me/messages"),
      ).length,
      0,
    );
  }),
);

it.live("an uncertain Outlook attachment POST lists and matches the uploaded bytes", () =>
  Effect.gen(function* () {
    let posts = 0;
    const http = fakeHttp({
      "POST /me/messages/original/createReply": { json: { id: "created" } },
      "PATCH /me/messages/created": { json: {} },
      "POST /me/messages/created/attachments": () => ({
        status: posts++ === 0 ? 503 : 200,
        json: {},
      }),
      "GET /me/messages/created/attachments": {
        json: { value: [{ id: "uploaded", name: "a.txt", contentBytes: "aGk=" }] },
      },
    });
    const remote = yield* run(http, (a) =>
      a.saveDraft(account, {
        creation: draftCreation(),
        remote: null,
        message: { ...draftMessage, mode: "reply" },
        original: Option.some({ providerId: "original", threadId: "t" }),
        replaceAttachments: true,
      }),
    );
    assert.strictEqual(remote.messageId, "created");
    assert.isUndefined(remote.saveError);
    assert.strictEqual(
      http.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/attachments"))
        .length,
      1,
    );
  }),
);

it.live(
  "a previously attempted Outlook create finds the draft and adds only missing attachments",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/mailFolders/drafts/messages": { json: { value: [{ id: "found" }] } },
        "PATCH /me/messages/found": { json: {} },
        "GET /me/messages/found/attachments": (url) => ({
          json: url.searchParams.has("page")
            ? { value: [{ id: "already-uploaded", name: "a.txt", contentBytes: "aGk=" }] }
            : {
                value: [],
                "@odata.nextLink":
                  "https://graph.microsoft.com/v1.0/me/messages/found/attachments?page=2",
              },
        }),
        "POST /me/messages/found/attachments": { json: {} },
        "POST /me/messages": { json: { id: "duplicate" } },
      });
      const remote = yield* run(http, (a) =>
        a.saveDraft(account, {
          remote: null,
          message: {
            ...draftMessage,
            attachments: [
              ...draftMessage.attachments,
              { filename: "b.txt", mimeType: "text/plain", content: "Yg==" },
            ],
          },
          original: Option.none(),
          replaceAttachments: true,
          creation: {
            missing: () => Effect.succeed(false),
            begin: () => Effect.succeed({ messageId: "<attempt@example.com>", attempted: true }),
            attempted: () => Effect.void,
            remember: () => Effect.void,
          },
        }),
      );
      assert.strictEqual(remote.messageId, "found");
      const posts = http.calls.filter((call) => call.method === "POST");
      assert.strictEqual(posts.length, 1);
      assert.strictEqual(
        Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(posts[0]?.body).name,
        "b.txt",
      );
    }),
);

it.live("forward replacement returns the new ID when deleting the old draft fails", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/old": { json: {} },
      "POST /me/messages/original/createForward": { json: { id: "new" } },
      "PATCH /me/messages/new": { json: {} },
      "POST /me/messages/new/attachments": { json: {} },
      "DELETE /me/messages/old": { status: 400 },
    });
    const remote = yield* run(http, (a) =>
      a.saveDraft(account, {
        creation: draftCreation(),
        remote: { draftId: "old", messageId: "old" },
        message: { ...draftMessage, mode: "forward" },
        original: Option.some({ providerId: "original", threadId: "t" }),
        replaceAttachments: true,
      }),
    );
    assert.strictEqual(remote.messageId, "new");
    assert.strictEqual(remote.replacedMessageId, "old");
  }),
);

it.live("an attachment 404 after PATCH does not recreate an Outlook draft", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "PATCH /me/messages/d": { json: {} },
      "GET /me/messages/d/attachments": { status: 404 },
      "POST /me/messages": { json: { id: "duplicate" } },
    });
    yield* run(http, (a) =>
      a
        .saveDraft(account, {
          creation: draftCreation(),
          remote: { draftId: "d", messageId: "d" },
          message: draftMessage,
          original: Option.none(),
          replaceAttachments: true,
        })
        .pipe(Effect.result),
    );
    assert.isFalse(
      http.calls.some((c) => c.method === "POST" && c.url.pathname.endsWith("/me/messages")),
    );
  }),
);

it.live("a reply draft keeps its new ID when later PATCH fails", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/original/createReply": { json: { id: "created" } },
      "PATCH /me/messages/created": { status: 400 },
    });
    const remote = yield* run(http, (a) =>
      a.saveDraft(account, {
        creation: draftCreation(),
        remote: null,
        message: { ...draftMessage, mode: "reply" },
        original: Option.some({ providerId: "original", threadId: "t" }),
        replaceAttachments: true,
      }),
    );
    assert.strictEqual(remote.messageId, "created");
  }),
);

it.live("Outlook checks changeKey before overwriting a draft", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/d": {
        json: {
          id: "d",
          changeKey: "other-client",
          lastModifiedDateTime: new Date(2000).toISOString(),
        },
      },
      "PATCH /me/messages/d": { json: { id: "d", changeKey: "overwritten" } },
      "POST /me/messages": { json: { id: "preserved-copy", changeKey: "copy" } },
    });
    const remote = yield* run(http, (a) =>
      a.saveDraft(account, {
        creation: draftCreation(),
        remote: { draftId: "d", messageId: "d", changeKey: "our-version", lastWrittenAt: 1000 },
        message: draftMessage,
        original: Option.none(),
        replaceAttachments: false,
      }),
    );
    assert.isTrue(remote.conflict);
    assert.strictEqual(remote.messageId, "preserved-copy");
    assert.isFalse(http.calls.some((c) => c.method === "PATCH"));
  }),
);

it.effect("composer draft labels/star patch categories and flag without moving out of Drafts", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "PATCH /me/messages/draft": { json: {} } });
    yield* run(http, (adapter) =>
      adapter.saveDraft(account, {
        creation: draftCreation(),
        remote: { draftId: "draft", messageId: "draft" },
        original: Option.none(),
        replaceAttachments: false,
        message: {
          ...draftMessage,
          draftOrganization: { labels: ["Work", "Project"], starred: true },
        },
      }),
    );
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        categories: Schema.Array(Schema.String),
        flag: Schema.Struct({ flagStatus: Schema.String }),
      }),
    )(http.calls[0]?.body);
    assert.deepStrictEqual(body.categories, ["Work", "Project"]);
    assert.deepStrictEqual(body.flag, { flagStatus: "flagged" });
    assert.deepStrictEqual(paths(http.calls), ["PATCH /me/messages/draft"]);
  }),
);

it.effect("body-only Outlook draft patches omit categories/flag and keep external edits", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "PATCH /me/messages/draft": { json: {} } });
    yield* run(http, (adapter) =>
      adapter.saveDraft(account, {
        creation: draftCreation(),
        remote: { draftId: "draft", messageId: "draft" },
        original: Option.none(),
        replaceAttachments: false,
        message: draftMessage,
      }),
    );
    const fields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      http.calls[0]?.body,
    );
    assert.strictEqual(Object.hasOwn(fields, "categories"), false);
    assert.strictEqual(Object.hasOwn(fields, "flag"), false);
  }),
);

it.effect(
  "Drafts delta update followed by removal deletes both cached message and editable draft",
  () => {
    const http = fakeHttp({
      "POST /$batch": { json: { responses: [{ id: "0", status: 404 }] } },
      ...mailbox({
        drafts: (url) =>
          url.searchParams.has("$skiptoken")
            ? {
                json: {
                  value: [{ id: "remote", "@removed": { reason: "deleted" } }],
                  "@odata.deltaLink": `${GRAPH}/me/mailFolders/drafts/messages/delta?$deltatoken=2`,
                },
              }
            : {
                json: {
                  value: [{ ...raw, id: "remote", hasAttachments: false, isDraft: true }],
                  "@odata.nextLink": `${GRAPH}/me/mailFolders/drafts/messages/delta?$skiptoken=next`,
                },
              },
      }),
    });
    const services = Layer.mergeAll(
      StoreLive,
      Layer.effect(Providers, makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter })))),
    ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
    return Effect.gen(function* () {
      const store = yield* Store,
        mailbox = yield* Mailbox;
      const saved = yield* store.upsertAccount("outlook", account.email);
      yield* store.saveSyncCursor(
        saved.id,
        JSON.stringify({
          __idType: "immutable",
          drafts: `${GRAPH}/me/mailFolders/drafts/messages/delta?$deltatoken=1`,
        }),
      );
      yield* store.putDraft({
        id: "editable",
        accountId: saved.id,
        message: { to: [], cc: [], bcc: [], subject: "Draft", text: "Text", attachments: [] },
      });
      yield* store.setDraftRemote("editable", { draftId: "remote", messageId: "remote" }, null);
      yield* mailbox.sync.sync(saved.id);
      assert.strictEqual(yield* store.messageIdForProvider(saved.id, "remote"), null);
      assert.isTrue(Option.isNone(yield* store.getDraft("editable")));
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(Layer.provideMerge(services)),
      ),
    );
  },
);
