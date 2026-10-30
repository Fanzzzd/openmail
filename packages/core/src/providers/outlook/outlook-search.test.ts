import { assert, it } from "@effect/vitest";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Logger, Schema } from "effect";
import { HtmlText } from "../../platform/html-text.js";
import { account, run, raw, mailbox } from "../../../test-support/outlook-fixtures.js";
it.effect("Graph search uses $search, immutable IDs and the selected folder", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders": { json: { value: [] } },
      "GET /me/mailFolders/inbox": { json: { id: "inbox-id" } },
      "GET /me/mailFolders/inbox/messages": (url) => {
        assert.ok(url.searchParams.get("$search")?.includes("from:"));
        assert.strictEqual(url.searchParams.has("$filter"), false);
        return { json: { value: [{ ...raw, parentFolderId: "inbox-id", hasAttachments: false }] } };
      },
    });
    const page = yield* run(http, (a) =>
      a.search(account, { search: "from:wang is:unread", searchScope: "folder", mailbox: "inbox" }),
    );
    assert.strictEqual(page.messages.length, 1);
    assert.ok(page.messages[0]?.labels.includes("INBOX"));
    assert.strictEqual(http.calls.at(-1)?.prefer, 'IdType="ImmutableId"');
  }),
);

it.effect(
  "Outlook server search ignores skipped or unmapped folders before fetching attachments",
  () => {
    const http = fakeHttp({
      "GET /me/mailFolders": { json: { value: [] } },
      "GET /me/mailFolders/inbox": { json: { id: "inbox-id" } },
      "GET /me/messages": {
        json: {
          value: [
            { ...raw, id: "outbox-copy", parentFolderId: "outbox-id" },
            { ...raw, id: "inbox-copy", parentFolderId: "inbox-id", hasAttachments: false },
          ],
        },
      },
    });
    return run(http, (a) => a.search(account, { search: "from:wang" })).pipe(
      Effect.tap((page) =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            page.messages.map((m) => m.providerId),
            ["inbox-copy"],
          );
          assert.ok(!http.calls.some((c) => c.url.pathname.includes("/attachments")));
        }),
      ),
    );
  },
);

it.effect("Outlook server search extracts HTML text only for messages within the limit", () => {
  const http = fakeHttp({
    "GET /me/mailFolders": { json: { value: [] } },
    "GET /me/mailFolders/inbox": { json: { id: "inbox-id" } },
    "GET /me/messages": {
      json: {
        value: Array.from({ length: 10 }, (_, i) => ({
          ...raw,
          id: `hit-${i}`,
          parentFolderId: "inbox-id",
          hasAttachments: false,
        })),
      },
    },
  });
  let extractions = 0;
  const counting: HtmlText = {
    htmlToText: (html) => Effect.sync(() => (extractions++, html)),
    visibleText: (plain) => Effect.succeed(plain),
    concurrency: 4,
  };
  return run(http, (a) => a.search(account, { search: "from:wang", limit: 3 })).pipe(
    Effect.provideService(HtmlText, counting),
    Effect.tap((page) =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          page.messages.map((m) => m.providerId),
          ["hit-0", "hit-1", "hit-2"],
        );
        assert.isTrue(page.truncated);
        assert.isAtMost(extractions, 3);
      }),
    ),
  );
});

it.effect(
  "Graph search outer wrapping roundtrips KQL values containing quotes and backslashes",
  () =>
    Effect.gen(function* () {
      const value = 'Alice "private" \\ archive';
      const query = {
        search: `from:${JSON.stringify(value)} subject:${JSON.stringify(value)} after:2026-10-02`,
      };
      const http = fakeHttp({
        "GET /me/mailFolders": { json: { value: [] } },
        "GET /me/messages": (url) => {
          const wrapped = url.searchParams.get("$search");
          assert.ok(wrapped);
          const kql = Schema.decodeUnknownSync(Schema.String)(JSON.parse(wrapped));
          assert.strictEqual(
            kql,
            `from:${JSON.stringify(value)} AND subject:${JSON.stringify(value)} AND received>=${new Date(2026, 9, 2).toISOString()}`,
          );
          return { json: { value: [] } };
        },
      });
      yield* run(http, (adapter) => adapter.search(account, query));
      assert.ok(http.calls.some((call) => call.url.pathname.endsWith("/me/messages")));
    }),
);

it.effect("plain Graph token uses the documented single search literal", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages": (url) => {
        assert.strictEqual(url.searchParams.get("$search"), '"E64KZJ"');
        assert.strictEqual(
          url.searchParams.get("$expand"),
          "attachments($select=name,contentType,size,isInline)",
        );
        assert.isFalse(url.searchParams.get("$select")?.includes("internetMessageHeaders"));
        assert.isFalse(url.searchParams.has("$filter"));
        assert.isFalse(url.searchParams.has("$orderby"));
        return { json: { value: [] } };
      },
    });
    yield* run(http, (adapter) =>
      adapter.search(account, { search: "E64KZJ", searchScope: "all" }),
    );
  }),
);

it.effect("search rejection has a search reason rather than a mutation reason", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ ...mailbox({}), "GET /me/messages": { status: 400 } });
    const error = yield* run(http, (adapter) =>
      adapter.search(account, { search: "E64KZJ" }).pipe(Effect.flip),
    );
    assert.strictEqual(error.message, "The server could not complete this search.");
  }),
);

it.effect("search rejection retains the fixed Graph code without response text", () =>
  Effect.gen(function* () {
    const records: unknown[] = [];
    const logger = Logger.make((options) =>
      records.push(...(Array.isArray(options.message) ? options.message : [options.message])),
    );
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages": {
        status: 400,
        json: { error: { code: "ErrorInvalidProperty", message: "private query" } },
      },
    });
    yield* run(http, (adapter) =>
      adapter
        .search(account, { search: "E64KZJ" })
        .pipe(Effect.result, Effect.provide(Logger.layer([logger]))),
    );
    assert.ok(
      records.some(
        (record) =>
          typeof record === "object" &&
          record !== null &&
          "errorCode" in record &&
          record.errorCode === "ErrorInvalidProperty",
      ),
    );
    assert.isFalse(JSON.stringify(records).includes("private"));
  }),
);

it.effect("punctuated search terms preserve the escaped KQL literal", () => {
  const http = fakeHttp({
    ...mailbox({}),
    "GET /me/messages": (url) => {
      const search = url.searchParams.get("$search");
      assert.ok(search);
      assert.strictEqual(
        Schema.decodeUnknownSync(Schema.String)(JSON.parse(search)),
        '"E64KZJ-123"',
      );
      return { json: { value: [] } };
    },
  });
  return run(http, (adapter) => adapter.search(account, { search: "E64KZJ-123" }));
});

for (const expanded of [true, false]) {
  it.effect(
    `search attachment metadata ${expanded ? "uses expansion" : "stays lazy when expansion is omitted"} without one GET per result`,
    () => {
      const attachment = { name: "file.txt", contentType: "text/plain", size: 10, isInline: false };
      const hits = Array.from({ length: 40 }, (_, index) => ({
        ...raw,
        id: `hit-${index}`,
        subject: "E64KZJ",
        parentFolderId: "id-inbox",
        hasAttachments: true,
      }));
      const http = fakeHttp({
        ...mailbox({}),
        ...Object.fromEntries(
          hits.map((hit) => [
            `GET /me/messages/${hit.id}/attachments`,
            { json: { value: [attachment] } },
          ]),
        ),
        "GET /me/messages": (url) => ({
          json: {
            value: hits.map((hit) => ({
              ...hit,
              ...(expanded && url.searchParams.has("$expand") ? { attachments: [attachment] } : {}),
            })),
          },
        }),
      });
      return run(http, (adapter) =>
        Effect.gen(function* () {
          const result = yield* adapter.search(account, { search: "E64KZJ" });
          assert.strictEqual(result.messages.length, 40);
          assert.strictEqual(result.messages[0]?.attachments.length, expanded ? 1 : 0);
          assert.strictEqual(result.messages[0]?.bodyCached, expanded);
          assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("/attachments")));
          assert.strictEqual(
            http.calls.filter((call) => call.url.pathname === "/v1.0/me/messages").length,
            1,
          );
        }),
      );
    },
  );
}
