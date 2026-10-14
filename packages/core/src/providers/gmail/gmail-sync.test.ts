import { fakeHttp } from "../../platform/node/fake-http.js";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { parseGmailMessage } from "./parse.js";
import { account, run, message, labels, tags } from "../../../test-support/gmail-fixtures.js";
it.effect("history turns into labels, upserts, deletes and a cursor", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "GET /history": (url) => {
        assert.strictEqual(url.searchParams.get("startHistoryId"), "100");
        return {
          json: {
            historyId: "150",
            history: [
              { messagesAdded: [{ message: { id: "m1" } }] },
              { labelsAdded: [{ message: { id: "m2" } }] },
              { messagesDeleted: [{ message: { id: "m3" } }] },
            ],
          },
        };
      },
      "GET /messages/m1": { json: message("m1", ["INBOX", "UNREAD"]) },
      // m2 is gone by the time it is fetched.
    });
    const changes = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.some("100"))));
    assert.deepStrictEqual(tags(changes), [
      "Labels",
      "Upsert",
      "Progress",
      "Delete",
      "Progress",
      "Delete",
      "Cursor",
    ]);
    assert.deepStrictEqual(changes[0], {
      _tag: "Labels",
      labels: [
        { id: "Label_1", name: "Clients", color: "#fb4c2f" },
        { id: "Label_2", name: "Clients/Acme", color: null },
      ],
    });
    const upsert = changes[1];
    assert.ok(upsert?._tag === "Upsert");
    assert.strictEqual(upsert.message.providerId, "m1");
    assert.strictEqual(upsert.message.isUnread, true);
    assert.strictEqual(upsert.message.snippet, "Tom & Jerry");
    assert.deepStrictEqual(changes[2], { _tag: "Progress", fetched: 1, total: 2 });
    assert.deepStrictEqual(changes[3], { _tag: "Delete", providerId: "m2" });
    assert.deepStrictEqual(changes[5], { _tag: "Delete", providerId: "m3" });
    assert.deepStrictEqual(changes[6], { _tag: "Cursor", cursor: "150" });
  }),
);

it.effect("a history cursor Gmail no longer has falls back to a full sync", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /history": { status: 404, json: { error: { code: 404 } } },
      "GET /profile": { json: { emailAddress: "me@gmail.com", historyId: "900" } },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("q"), "newer_than:90d");
        assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
        return { json: { messages: [{ id: "m1" }] } };
      },
      "GET /messages/m1": { json: message("m1", ["SPAM"]) },
    });
    const changes = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.some("1"))));
    assert.deepStrictEqual(tags(changes), ["Labels", "Upsert", "Progress", "Reset", "Cursor"]);
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "900" });
  }),
);

it("parses nested parts with their declared charset", () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]).toString("base64url");
  const m = parseGmailMessage({
    id: "m",
    threadId: "t",
    internalDate: "1",
    payload: {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          headers: [{ name: "Content-Type", value: 'text/plain; charset="gbk"' }],
          body: { size: 4, data: gbk },
        },
        { mimeType: "application/pdf", filename: "a.pdf", body: { size: 10 } },
      ],
    },
  });
  assert.strictEqual(m.bodyText, "你好");
  assert.deepStrictEqual(m.attachments, [
    { filename: "a.pdf", mimeType: "application/pdf", size: 10 },
  ]);
  assert.deepStrictEqual(m.labels, []);
});

it("reads text Gmail already converted to UTF-8 even when the header names another charset", () => {
  // Outlook re-encodes Chinese mail as gb2312; Gmail's API returns it as UTF-8.
  const utf8 = Buffer.from("粗体 和 代码", "utf8").toString("base64url");
  const m = parseGmailMessage({
    id: "m",
    threadId: "t",
    internalDate: "1",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Content-Type", value: 'text/html; charset="gb2312"' }],
      body: { size: 18, data: utf8 },
    },
  });
  assert.strictEqual(m.bodyHtml, "粗体 和 代码");
});

it.effect("inbox polling reads only inbox history and does not replace cached labels", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /history": (url) => {
        assert.strictEqual(url.searchParams.get("labelId"), "INBOX");
        assert.strictEqual(url.searchParams.get("startHistoryId"), "100");
        return {
          json: { historyId: "101", history: [{ messagesAdded: [{ message: { id: "new" } }] }] },
        };
      },
      "GET /messages/new": { json: message("new", ["INBOX", "UNREAD"]) },
    });
    const changes = yield* run(http, (adapter) =>
      Stream.runCollect(adapter.pull(account, Option.some("100"), "inbox")),
    );
    assert.deepStrictEqual(tags(changes), ["Upsert", "Progress", "Cursor"]);
    assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("/labels")));
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "101" });
  }),
);

it.effect("historical pages resume with a fixed snapshot without touching history", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages": (url) => ({
        json: url.searchParams.has("pageToken")
          ? { messages: [{ id: "older" }] }
          : { messages: [{ id: "old" }], nextPageToken: "next" },
      }),
      "GET /messages/old": { json: message("old", ["INBOX"]) },
      "GET /messages/older": { json: message("older", ["SPAM"]) },
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const first = yield* adapter.backfill(account, { cursor: null, before: 1_700_000_000_000 });
        assert.strictEqual(first.cursor, "next");
        assert.strictEqual(first.messages[0]?.providerId, "old");
        const second = yield* adapter.backfill(account, {
          cursor: first.cursor,
          before: 1_700_000_000_000,
        });
        assert.strictEqual(second.cursor, null);
        assert.strictEqual(second.messages[0]?.providerId, "older");
      }),
    );
    const lists = http.calls.filter((c) => c.url.pathname.endsWith("/messages"));
    assert.deepStrictEqual(
      lists.map((c) => c.url.searchParams.get("q")),
      ["before:1700000000", "before:1700000000"],
    );
    assert.strictEqual(lists[1]?.url.searchParams.get("pageToken"), "next");
    assert.strictEqual(
      http.calls.some((c) => c.url.pathname.endsWith("/history")),
      false,
    );
  }),
);

it.effect("backfill filters listed Gmail ids before any body download", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages": {
        json: {
          messages: [{ id: "cached" }, { id: "pending" }, { id: "missing" }],
          nextPageToken: "later",
        },
      },
      "GET /messages/missing": { json: message("missing", ["INBOX"]) },
    });
    const page = yield* run(http, (a) =>
      a.backfill(account, { cursor: null, before: 1_700_000_000_000 }, (ids) => {
        assert.deepStrictEqual(ids, ["cached", "pending", "missing"]);
        return Effect.succeed(["missing"]);
      }),
    );
    assert.strictEqual(page.scanned, 3);
    assert.strictEqual(page.cursor, "later");
    assert.deepStrictEqual(
      page.messages.map((m) => m.providerId),
      ["missing"],
    );
    assert.deepStrictEqual(
      http.calls.filter((c) => c.url.pathname.includes("/messages/")).map((c) => c.url.pathname),
      ["/gmail/v1/users/me/messages/missing"],
    );
  }),
);

it.effect("label-only history reads minimal and additions read full", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /history": {
        json: {
          historyId: "2",
          history: [
            {
              labelsAdded: [{ message: { id: "labels" } }],
              messagesAdded: [{ message: { id: "added" } }],
            },
          ],
        },
      },
      "GET /messages/labels": { json: { id: "labels", labelIds: ["INBOX", "STARRED"] } },
      "GET /messages/added": { json: message("added", ["INBOX"]) },
    });
    const changes = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.some("1"))));
    assert.ok(changes.some((c) => c._tag === "MessageLabels"));
    assert.strictEqual(
      http.calls
        .find((c) => c.url.pathname.endsWith("/labels") && c.url.searchParams.has("format"))
        ?.url.searchParams.get("format"),
      "minimal",
    );
    assert.strictEqual(
      http.calls.find((c) => c.url.pathname.endsWith("/added"))?.url.searchParams.get("format"),
      "full",
    );
  }),
);

it.effect(
  "background Gmail pull refuses missing and expired history without listing or full sync",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({ "GET /history": { status: 404 } });
      for (const cursor of [Option.none<string>(), Option.some("expired")]) {
        const result = yield* run(http, (adapter) =>
          Stream.runCollect(adapter.pull(account, cursor, "inbox", true)).pipe(Effect.result),
        );
        assert.strictEqual(result._tag, "Failure");
      }
      assert.isFalse(http.calls.some((call) => /messages|profile|labels/.test(call.url.pathname)));
    }),
);

it.effect("Gmail sync health only GETs label message/unread/thread counts", () => {
  const http = fakeHttp({
    "GET /labels/Label_private": {
      json: { messagesTotal: 12, messagesUnread: 3, threadsTotal: 8 },
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const status = yield* adapter.folderStatus(account, "Label_private");
      assert.deepStrictEqual(status, {
        total: 12,
        unread: 3,
        threads: 8,
        uidNext: null,
        uidValidity: null,
      });
      const calls = http.calls.filter((call) => call.url.hostname === "gmail.googleapis.com");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.method, "GET");
      assert.strictEqual(calls[0]?.url.pathname, "/gmail/v1/users/me/labels/Label_private");
    }),
  );
});

it.effect("label-only category removal accepts minimal messages with no remaining labels", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: { labels: [{ id: "CATEGORY_PERSONAL", name: "Personal", type: "system" }] },
      },
      "GET /history": {
        json: {
          historyId: "2",
          history: [
            { labelsRemoved: [{ message: { id: "m1" }, labelIds: ["CATEGORY_PERSONAL"] }] },
          ],
        },
      },
      "GET /messages/m1": { json: { id: "m1" } },
    });
    const changes = yield* run(http, (adapter) =>
      Stream.runCollect(adapter.pull(account, Option.some("1"))),
    );
    assert.deepStrictEqual(
      changes.filter((c) => c._tag === "MessageLabels"),
      [{ _tag: "MessageLabels", providerId: "m1", labels: [] }],
    );
    assert.strictEqual(
      http.calls
        .find((c) => c.url.pathname.endsWith("/messages/m1"))
        ?.url.searchParams.get("format"),
      "minimal",
    );
  }),
);

it.effect(
  "Gmail header backfill requests metadata only, preserves repeated fields and tolerates 404",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /messages/a": {
          json: {
            payload: {
              headers: [
                { name: "Message-ID", value: "<old@example.test>" },
                { name: "Delivered-To", value: "one@example.test" },
                { name: "Delivered-To", value: "two@example.test" },
              ],
            },
          },
        },
        "GET /messages/no-id": { json: { payload: { headers: [] } } },
      });
      const results = yield* run(http, (adapter) => {
        if (!adapter.fetchCachedHeaders) return Effect.die("Missing header reader");
        return adapter.fetchCachedHeaders(account, ["a", "gone", "no-id"]);
      });
      assert.deepStrictEqual(results, [
        {
          kind: "headers",
          id: "a",
          rfcMessageId: "<old@example.test>",
          headers: [
            { name: "message-id", value: "<old@example.test>" },
            { name: "delivered-to", value: "one@example.test" },
            { name: "delivered-to", value: "two@example.test" },
          ],
        },
        { kind: "unavailable", id: "gone" },
        { kind: "headers", id: "no-id", rfcMessageId: null, headers: [] },
      ]);
      assert.isTrue(
        http.calls.every(
          (call) => call.method === "GET" && call.url.searchParams.get("format") === "metadata",
        ),
      );
      assert.isTrue(
        http.calls.every((call) =>
          ["message-id", "list-id", "delivered-to"].every((header) =>
            call.url.searchParams.getAll("metadataHeaders").includes(header),
          ),
        ),
      );
    }),
);

it.effect("Gmail header backfill stops sequential reads when Retry-After exceeds its budget", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "GET /messages/a": { status: 429, headers: { "Retry-After": "61" } } });
    const result = yield* run(http, (adapter) => {
      if (!adapter.fetchCachedHeaders) return Effect.die("Missing header reader");
      return adapter.fetchCachedHeaders(account, ["a", "b"]).pipe(Effect.result);
    });
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(http.calls.length, 1);
  }),
);

it.effect("Gmail category undercounts use paginated IDs including spam/trash", () => {
  const ids = Array.from({ length: 22 }, (_, index) => ({ id: `m${index}` }));
  const http = fakeHttp({
    "GET /labels/CATEGORY_PERSONAL": {
      json: { messagesTotal: 0, messagesUnread: 0, threadsTotal: 0 },
    },
    "GET /messages": (url) => {
      assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
      assert.ok(url.searchParams.getAll("labelIds").includes("CATEGORY_PERSONAL"));
      if (url.searchParams.getAll("labelIds").includes("UNREAD")) return { json: { messages: [] } };
      return {
        json: url.searchParams.has("pageToken")
          ? { messages: ids.slice(10) }
          : { messages: ids.slice(0, 10), nextPageToken: "next" },
      };
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const counts = yield* adapter.folderStatus(account, "CATEGORY_PERSONAL", {
        localTotal: 22,
        summary: yield* adapter.folderStatus(account, "CATEGORY_PERSONAL"),
      });
      assert.strictEqual(counts.total, 22);
      assert.strictEqual(counts.unread, 0);
      assert.isFalse(http.calls.some((call) => /messages\//.test(call.url.pathname)));
    }),
  );
});

it.effect("a capped category recheck retains the summary and skips unread listing", () => {
  let pages = 0;
  const http = fakeHttp({
    "GET /labels/CATEGORY_PERSONAL": {
      json: { messagesTotal: 999, messagesUnread: 100, threadsTotal: 20_000 },
    },
    "GET /messages": (url) => {
      assert.isFalse(url.searchParams.getAll("labelIds").includes("UNREAD"));
      return {
        json: {
          messages: Array.from({ length: 500 }, (_, index) => ({ id: `page-${pages}-${index}` })),
          nextPageToken: String(++pages),
        },
      };
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const summary = yield* adapter.folderStatus(account, "CATEGORY_PERSONAL");
      assert.deepStrictEqual(
        yield* adapter.folderStatus(account, "CATEGORY_PERSONAL", { localTotal: 30_000, summary }),
        summary,
      );
      assert.strictEqual(pages, 2);
      assert.strictEqual(
        http.calls.filter((call) => call.url.pathname.includes("/labels/")).length,
        1,
      );
    }),
  );
});

it.effect("category summaries above the listing capacity skip repeated rechecks", () => {
  const http = fakeHttp({
    "GET /labels/CATEGORY_PERSONAL": {
      json: { messagesTotal: 1001, messagesUnread: 100, threadsTotal: 1000 },
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const summary = yield* adapter.folderStatus(account, "CATEGORY_PERSONAL");
      for (let pass = 0; pass < 3; pass++)
        assert.deepStrictEqual(
          yield* adapter.folderStatus(account, "CATEGORY_PERSONAL", { localTotal: 2000, summary }),
          summary,
        );
      assert.strictEqual(http.calls.length, 1);
    }),
  );
});

it.effect("a first sync saves its history id and a retry skips the messages it stored", () =>
  Effect.gen(function* () {
    let profileCalls = 0;
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /profile": () => {
        profileCalls++;
        return { json: { emailAddress: "me@gmail.com", historyId: String(900 + profileCalls) } };
      },
      "GET /messages": { json: { messages: [{ id: "m1" }, { id: "m2" }] } },
      "GET /messages/m1": { json: message("m1", ["INBOX"]) },
      "GET /messages/m2": { json: message("m2", ["INBOX"]) },
    });
    const first = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.none())));
    assert.deepStrictEqual(first[1], { _tag: "Cursor", cursor: "initial:901", checkpoint: true });
    assert.deepStrictEqual(first.at(-1), { _tag: "Cursor", cursor: "901" });

    const before = http.calls.length;
    const resumed = yield* run(http, (a) =>
      Stream.runCollect(
        a.pull(account, Option.some("initial:901"), undefined, false, () =>
          Effect.succeed(new Set(["m1"])),
        ),
      ),
    );
    const paths = http.calls.slice(before).map((c) => c.url.pathname.replace(/^.*\/users\/me/, ""));
    assert.notInclude(paths, "/messages/m1");
    assert.notInclude(paths, "/profile");
    assert.include(paths, "/messages/m2");
    assert.deepStrictEqual(tags(resumed), ["Labels", "Upsert", "Progress", "Cursor"]);
    assert.deepStrictEqual(resumed[2], { _tag: "Progress", fetched: 2, total: 2 });
    // History from the first attempt's id covers changes to the skipped message.
    assert.deepStrictEqual(resumed.at(-1), { _tag: "Cursor", cursor: "901" });
  }),
);

it.effect("an inbox poll from a first sync's checkpoint skips the messages already stored", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages": { json: { messages: [{ id: "m1" }, { id: "m2" }] } },
      "GET /messages/m1": { json: message("m1", ["INBOX"]) },
      "GET /messages/m2": { json: message("m2", ["INBOX"]) },
    });
    const changes = yield* run(http, (a) =>
      Stream.runCollect(
        a.pull(account, Option.some("initial:901"), "inbox", false, () =>
          Effect.succeed(new Set(["m1", "m2"])),
        ),
      ),
    );
    const paths = http.calls.map((c) => c.url.pathname.replace(/^.*\/users\/me/, ""));
    assert.notInclude(paths, "/messages/m1");
    assert.notInclude(paths, "/messages/m2");
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "901" });
  }),
);
