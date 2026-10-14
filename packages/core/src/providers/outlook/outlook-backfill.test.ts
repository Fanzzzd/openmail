import { assert, it } from "@effect/vitest";
import { backfillCachedHeaders } from "../../sync/header-backfill.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { parseGraphMessage } from "./parse.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";
import { GRAPH, account, run, raw, mailbox } from "../../../test-support/outlook-fixtures.js";
it("maps a Graph message onto the store shape", () => {
  const m = parseGraphMessage(raw, "INBOX", [
    { filename: "quote.pdf", mimeType: "application/pdf", size: 100 },
  ]);
  assert.strictEqual(m.providerId, "AAMk123");
  assert.strictEqual(m.threadId, "conv-1");
  assert.strictEqual(m.webLink, raw.webLink);
  assert.strictEqual(m.from.address, "wang@contoso.com");
  assert.deepStrictEqual(m.labels.toSorted(), ["INBOX", "STARRED", "UNREAD"]);
  assert.strictEqual(m.isUnread, true);
  assert.strictEqual(m.isStarred, true);
  assert.strictEqual(m.bodyText, "已确认报价");
  assert.strictEqual(m.bodyHtml, "<p>已确认<b>报价</b></p>");
  assert.strictEqual(m.date, Date.parse("2026-09-20T02:30:00Z"));
  assert.strictEqual(m.attachments.length, 1);
});

it("a read plain-text message in Sent has only the folder label", () => {
  const m = parseGraphMessage(
    {
      ...raw,
      isRead: true,
      flag: { flagStatus: "notFlagged" },
      body: { contentType: "text", content: "纯文本正文" },
    },
    "SENT",
    [],
  );
  assert.deepStrictEqual(m.labels, ["SENT"]);
  assert.strictEqual(m.bodyText, "纯文本正文");
  assert.strictEqual(m.bodyHtml, "");
});

it.effect(
  "media raw size uses body and inline attachment metadata before Graph MIME download",
  () =>
    Effect.gen(function* () {
      let rawCalls = 0;
      const http = fakeHttp({
        "GET /me/messages/m1": { json: { body: { content: '<img src="cid:large">' } } },
        "GET /me/messages/m1/attachments": { json: { value: [{ size: 10_000_000 }] } },
        "GET /me/messages/m1/$value": () => {
          rawCalls++;
          return { text: "body" };
        },
      });
      const result = yield* run(http, (adapter) =>
        adapter.fetchRaw(account, "m1", 8 * 1024 * 1024),
      ).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(rawCalls, 0);
    }),
);

it.effect("Graph backfill follows nextLink, maps folders, and refuses foreign continuations", () =>
  Effect.gen(function* () {
    const next = `${GRAPH}/me/messages?$skiptoken=older`;
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages/AAMk123": {
        json: { ...raw, hasAttachments: false, parentFolderId: "id-inbox" },
      },
      "GET /me/messages": (url) => ({
        json: {
          value: [{ ...raw, hasAttachments: false, parentFolderId: "id-inbox" }],
          ...(url.searchParams.has("$skiptoken") ? {} : { "@odata.nextLink": next }),
        },
      }),
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const first = yield* adapter.backfill(account, { cursor: null, before: 1_700_000_000_000 });
        assert.strictEqual(first.cursor, next);
        assert.ok(first.messages[0]?.labels.includes("INBOX"));
        const second = yield* adapter.backfill(account, {
          cursor: first.cursor,
          before: 1_700_000_000_000,
        });
        assert.strictEqual(second.cursor, null);
        const foreign = yield* Effect.result(
          adapter.backfill(account, { cursor: "https://fake.invalid/steal", before: 0 }),
        );
        assert.strictEqual(foreign._tag, "Failure");
      }),
    );
    const lists = http.calls.filter((c) => c.url.pathname.endsWith("/me/messages"));
    assert.strictEqual(lists[0]?.url.searchParams.get("$orderby"), "receivedDateTime desc");
    assert.strictEqual(
      lists[0]?.url.searchParams.get("$filter"),
      "receivedDateTime lt 2023-11-14T22:13:20.000Z",
    );
    assert.strictEqual(lists[1]?.url.searchParams.get("$skiptoken"), "older");
    assert.ok(http.calls.every((c) => c.url.origin === "https://graph.microsoft.com"));
  }),
);

it.effect(
  "Graph backfill lists headers first and never fetches cached/pending bodies or attachments",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        ...mailbox({}),
        "GET /me/messages": (url) => {
          assert.strictEqual(url.searchParams.get("$select"), "id,receivedDateTime");
          return { json: { value: [{ id: "cached" }, { id: "pending" }, { id: "missing" }] } };
        },
        "GET /me/messages/missing": {
          json: { ...raw, id: "missing", parentFolderId: "id-inbox", hasAttachments: false },
        },
      });
      const page = yield* run(http, (a) =>
        a.backfill(account, { cursor: null, before: 1_700_000_000_000 }, (ids) => {
          assert.deepStrictEqual(ids, ["cached", "pending", "missing"]);
          return Effect.succeed(["missing"]);
        }),
      );
      assert.strictEqual(page.scanned, 3);
      assert.deepStrictEqual(
        page.messages.map((m) => m.providerId),
        ["missing"],
      );
      assert.ok(
        !http.calls.some((c) => /messages\/(cached|pending)|\/attachments/.test(c.url.pathname)),
      );
    }),
);

it.effect("Graph expanded attachment metadata avoids per-message requests", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      ...mailbox({}),
      [`GET /me/messages/${raw.id}`]: {
        json: {
          ...raw,
          parentFolderId: "id-inbox",
          attachments: [
            { name: "report.pdf", contentType: "application/pdf", size: 4, isInline: false },
          ],
        },
      },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, raw.id));
    assert.deepStrictEqual(m.attachments, [
      { filename: "report.pdf", mimeType: "application/pdf", size: 4 },
    ]);
    assert.isFalse(http.calls.some((c) => c.url.pathname.endsWith("/attachments")));
    assert.strictEqual(
      http.calls.find((c) => c.url.pathname.endsWith(raw.id))?.url.searchParams.get("$expand"),
      "attachments($select=name,contentType,size,isInline)",
    );
  }),
);

it.effect("Graph JSON signed containers use raw MIME for the body", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages/signed": {
        json: {
          ...raw,
          id: "signed",
          parentFolderId: "id-inbox",
          internetMessageHeaders: [
            { name: "Content-Type", value: "application/pkcs7-mime; smime-type=signed-data" },
          ],
          body: { contentType: "text", content: "" },
          attachments: [{ name: "smime.p7m", contentType: "application/pkcs7-mime", size: 100 }],
        },
      },
      "GET /me/messages/signed/attachments": { json: { value: [{ size: 100 }] } },
      "GET /me/messages/signed/$value": {
        text: "Content-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\nMFEGCSqGSIb3DQEHAqBEMEICAQExADA7BgkqhkiG9w0BBwGgLgQsQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluDQoNCnNpZ25lZCBKU09OIGJvZHk=",
      },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, "signed"));
    assert.strictEqual(m.bodyText.trim(), "signed JSON body");
    assert.deepStrictEqual(
      m.attachments.map((part) => part.filename),
      ["smime.p7m"],
    );
  }),
);

it.effect("Graph JSON uuencode attachments are listed and fetched from raw MIME", () =>
  Effect.gen(function* () {
    const text = "hello\r\nbegin 644 file.txt\r\n#0V%T\r\n`\r\nend\r\n";
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages/uu": {
        json: {
          ...raw,
          id: "uu",
          parentFolderId: "id-inbox",
          body: { contentType: "text", content: text },
          attachments: [],
        },
      },
      "GET /me/messages/uu/attachments": { json: { value: [] } },
      "GET /me/messages/uu/$value": { text: `Content-Type: text/plain\r\n\r\n${text}` },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const m = yield* a.fetchMessage(account, "uu");
        assert.strictEqual(m.attachments[0]?.filename, "file.txt");
        assert.strictEqual(
          Buffer.from(
            yield* a.fetchAttachment(account, "uu", {
              index: 0,
              filename: "file.txt",
              occurrence: 0,
            }),
          ).toString(),
          "Cat",
        );
      }),
    );
  }),
);

it.effect("oversized opaque Graph MIME falls back without blocking the message", () =>
  Effect.gen(function* () {
    const opaque = {
      ...raw,
      id: "opaque",
      parentFolderId: "id-inbox",
      body: { contentType: "text", content: "Original message" },
      internetMessageHeaders: [
        { name: "Content-Type", value: "application/pkcs7-mime; smime-type=signed-data" },
      ],
      attachments: [{ name: "smime.p7m", contentType: "application/pkcs7-mime", size: 100 }],
    };
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages/opaque": { json: opaque },
      "GET /me/messages/opaque/attachments": { json: { value: [{ size: 100 }] } },
      "GET /me/messages/opaque/$value": {
        text: "Content-Type: text/plain\r\n\r\nOversized decoded body",
        headers: { "Content-Length": String(26 * 1024 * 1024) },
      },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, "opaque"));
    assert.strictEqual(m.bodyText, "Original message");
    assert.strictEqual(m.attachments[0]?.filename, "smime.p7m");
  }),
);

it.effect("Graph signed files preserve the outer JSON message body", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages/invoice": {
        json: {
          ...raw,
          id: "invoice",
          parentFolderId: "id-inbox",
          body: { contentType: "text", content: "Invoice enclosed" },
          internetMessageHeaders: [{ name: "Content-Type", value: "multipart/mixed; boundary=x" }],
          attachments: [
            { name: "invoice.pdf.p7m", contentType: "application/pkcs7-mime", size: 100 },
          ],
        },
      },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, "invoice"));
    assert.strictEqual(m.bodyText, "Invoice enclosed");
    assert.strictEqual(m.attachments[0]?.filename, "invoice.pdf.p7m");
    assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("/$value")));
  }),
);

it.effect(
  "Graph header backfill batches only GETs with explicit internetMessageHeaders selection",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /$batch": {
          json: {
            responses: [
              {
                id: "0",
                status: 200,
                body: {
                  internetMessageId: "<old@example.test>",
                  internetMessageHeaders: [{ name: "List-ID", value: "list.example.test" }],
                },
              },
              { id: "1", status: 404 },
              { id: "2", status: 200, body: { internetMessageHeaders: [] } },
            ],
          },
        },
      });
      const results = yield* run(http, (adapter) => {
        if (!adapter.fetchCachedHeaders) return Effect.die("Missing header reader");
        return adapter.fetchCachedHeaders(account, ["a/encoded", "gone", "no-id"]);
      });
      assert.deepStrictEqual(results, [
        {
          kind: "headers",
          id: "a/encoded",
          rfcMessageId: "<old@example.test>",
          headers: [{ name: "list-id", value: "list.example.test" }],
        },
        { kind: "unavailable", id: "gone" },
        { kind: "headers", id: "no-id", rfcMessageId: null, headers: [] },
      ]);
      const batch = Schema.decodeUnknownSync(
        Schema.Struct({
          requests: Schema.Array(
            Schema.Struct({
              method: Schema.String,
              url: Schema.String,
              headers: Schema.Struct({ prefer: Schema.String }),
            }),
          ),
        }),
      )(http.calls[0]?.body);
      assert.strictEqual(batch.requests.length, 3);
      for (const request of batch.requests) {
        assert.strictEqual(request.method, "GET");
        assert.strictEqual(
          new URL(request.url, GRAPH).searchParams.get("$select"),
          "internetMessageId,internetMessageHeaders",
        );
        assert.include(request.headers.prefer, 'IdType="ImmutableId"');
      }
      assert.include(batch.requests[0]?.url ?? "", "a%2Fencoded");
    }),
);

it.effect("Graph header backfill honors inner Retry-After and rejects malformed headers", () =>
  Effect.gen(function* () {
    for (const reply of [
      { json: { responses: [{ id: "0", status: 429, headers: { "Retry-After": "61" } }] } },
      {
        json: {
          responses: [
            {
              id: "0",
              status: 200,
              body: {
                internetMessageId: "<only@example.test>",
                internetMessageHeaders: "malformed",
              },
            },
          ],
        },
      },
    ]) {
      const http = fakeHttp({ "POST /$batch": reply });
      const result = yield* run(http, (adapter) => {
        if (!adapter.fetchCachedHeaders) return Effect.die("Missing header reader");
        return adapter.fetchCachedHeaders(account, ["a"]).pipe(Effect.result);
      });
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(http.calls.length, 1);
    }
  }),
);

for (const total of [1000, 1041]) {
  it.effect(
    `Graph repairs ${total} legacy rows and finishes only after checking the final page`,
    () =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const Requests = Schema.Struct({
          requests: Schema.Array(
            Schema.Struct({ id: Schema.String, method: Schema.Literal("GET"), url: Schema.String }),
          ),
        });
        const http = fakeHttp({
          "POST /$batch": (_url, call) => {
            const batch = Schema.decodeUnknownSync(Requests)(call.body).requests;
            assert.isAtMost(batch.length, 20);
            return {
              json: {
                responses: batch.map((entry) => {
                  const id = decodeURIComponent(
                    new URL(entry.url, GRAPH).pathname.split("/").at(-1) ?? "",
                  );
                  requests.push(id);
                  const n = Number(id.slice(1));
                  return {
                    id: entry.id,
                    status: 200,
                    body: {
                      ...(n % 10 === 1 ? {} : { internetMessageId: `<${id}@example.test>` }),
                      ...(n % 3 === 0
                        ? {}
                        : {
                            internetMessageHeaders: [
                              { name: "List-ID", value: "list.example.test" },
                            ],
                          }),
                    },
                  };
                }),
              },
            };
          },
        });
        const store = yield* Store;
        const owner = yield* store.upsertAccount("outlook", account.email);
        const cached = parseGraphMessage({ ...raw, hasAttachments: false }, "INBOX", []);
        yield* store.transaction(
          Effect.gen(function* () {
            for (let n = 0; n < total; n++)
              yield* store.upsertMessage(owner.id, {
                ...cached,
                providerId: `m${n}`,
                date: n,
                ...(n % 2 === 0 ? { rfcMessageId: `<m${n}@example.test>` } : {}),
              });
          }),
        );
        yield* run(http, (adapter) =>
          Effect.gen(function* () {
            const passes = Math.ceil(total / 500);
            for (let pass = 0; pass < passes; pass++) {
              const before = requests.length;
              yield* backfillCachedHeaders(store, adapter, owner);
              assert.strictEqual(requests.length - before, Math.min(500, total - pass * 500));
              assert.strictEqual(
                (yield* store.headerBackfillState(owner.id)).kind,
                pass === passes - 1 && total % 500 !== 0 ? "done" : "running",
              );
            }
            if (total % 500 === 0) {
              const batches = http.calls.length;
              yield* backfillCachedHeaders(store, adapter, owner);
              assert.strictEqual(http.calls.length, batches);
            }
            assert.strictEqual((yield* store.headerBackfillState(owner.id)).kind, "done");
            assert.strictEqual(new Set(requests).size, total);
            yield* backfillCachedHeaders(store, adapter, owner);
            assert.strictEqual(requests.length, total);
            assert.strictEqual(http.calls.length, Math.ceil(total / 20));
            const noIdentity = yield* store.getMessage(`${owner.id}/m21`);
            assert.isUndefined(noIdentity.rfcMessageId);
            assert.deepStrictEqual(noIdentity.headers, []);
            const empty = yield* store.getMessage(`${owner.id}/m3`);
            assert.deepStrictEqual(empty.headers, []);
            assert.strictEqual(empty.rfcMessageId, "<m3@example.test>");
            assert.strictEqual(
              (yield* store.getMessage(`${owner.id}/m0`)).rfcMessageId,
              "<m0@example.test>",
            );
            assert.isTrue(empty.isUnread);
            assert.isTrue(empty.isStarred);
            assert.deepStrictEqual(empty.labels, ["INBOX", "UNREAD", "STARRED"]);
          }),
        );
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

it.effect(
  "Graph backfill preserves inner Retry-After across scheduled/manual passes and read requests",
  () =>
    Effect.gen(function* () {
      let throttled = true;
      // Route state changes after the server deadline; no real waiting or credentials.
      const routed = fakeHttp({
        "POST /$batch": () =>
          throttled
            ? { json: { responses: [{ id: "0", status: 429, headers: { "Retry-After": "120" } }] } }
            : {
                json: {
                  responses: [
                    { id: "0", status: 200, body: { internetMessageId: "<a@example.test>" } },
                  ],
                },
              },
        "GET /me/messages/a": {
          json: { ...raw, id: "a", hasAttachments: false, parentFolderId: "inbox" },
        },
      });
      const store = yield* Store;
      const owner = yield* store.upsertAccount("outlook", account.email);
      yield* store.upsertMessage(owner.id, {
        ...parseGraphMessage({ ...raw, id: "a", hasAttachments: false }, "INBOX", []),
        date: 1,
      });
      yield* run(routed, (adapter) =>
        Effect.gen(function* () {
          const first = yield* backfillCachedHeaders(store, adapter, owner).pipe(Effect.result);
          assert.strictEqual(first._tag, "Failure");
          assert.strictEqual(routed.calls.length, 1);
          yield* TestClock.adjust("10 seconds");
          yield* backfillCachedHeaders(store, adapter, owner);
          const get = yield* adapter.fetchMessage(owner, "a").pipe(Effect.result);
          assert.strictEqual(get._tag, "Failure");
          assert.strictEqual(
            routed.calls.length,
            1,
            "the account gate prevents unrelated reads from bypassing Retry-After",
          );
          yield* TestClock.adjust("109 seconds");
          yield* backfillCachedHeaders(store, adapter, owner);
          assert.strictEqual(routed.calls.length, 1);
          throttled = false;
          yield* TestClock.adjust("1 second");
          yield* backfillCachedHeaders(store, adapter, owner);
          assert.strictEqual(routed.calls.length, 2);
          assert.strictEqual((yield* store.headerBackfillState(owner.id)).kind, "done");
        }),
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("Graph header backfill accepts successful replies with omitted or null headers", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /$batch": {
        json: {
          responses: [
            { id: "0", status: 200, body: { internetMessageId: "<one@example.test>" } },
            {
              id: "1",
              status: 200,
              body: { internetMessageId: "<two@example.test>", internetMessageHeaders: null },
            },
            { id: "2", status: 200, body: {} },
          ],
        },
      },
    });
    const rows = yield* run(http, (adapter) => {
      if (!adapter.fetchCachedHeaders) return Effect.die("Missing header reader");
      return adapter.fetchCachedHeaders(account, ["one", "two", "three"]);
    });
    assert.deepStrictEqual(rows, [
      { kind: "headers", id: "one", rfcMessageId: "<one@example.test>", headers: [] },
      { kind: "headers", id: "two", rfcMessageId: "<two@example.test>", headers: [] },
      { kind: "headers", id: "three", rfcMessageId: null, headers: [] },
    ]);
  }),
);
