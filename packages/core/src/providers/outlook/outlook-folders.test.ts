import { assert, it } from "@effect/vitest";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeOutlook } from "./outlook.js";
import { parseGraphMessage } from "./parse.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import {
  GRAPH,
  account,
  platformOptions,
  run,
  raw,
} from "../../../test-support/outlook-fixtures.js";
it.live("Outlook folder conflict resolves the existing folder in its parent", () =>
  Effect.gen(function* () {
    let posted = false;
    const http = fakeHttp({
      "GET /me/mailFolders": () => ({
        json: {
          value: posted
            ? [{ id: "existing", displayName: "Work", childFolderCount: 0, totalItemCount: 0 }]
            : [],
        },
      }),
      "POST /me/mailFolders": () => {
        posted = true;
        return { status: 409 };
      },
    });
    const labels = yield* run(http, (a) =>
      a.changeLabel(account, { kind: "create", name: "Work" }),
    );
    assert.strictEqual(labels.find((label) => label.name === "Work")?.id, "existing");
  }),
);

it.effect("ops map onto PATCH and move destinations", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "PATCH /me/messages/p": { json: {} },
      "POST /me/messages/p/move": { json: { id: "p" } },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.push(account, "p", { kind: "read", value: true });
        yield* a.push(account, "p", { kind: "star", value: false });
        yield* a.push(account, "p", { kind: "archive" });
        yield* a.push(account, "p", { kind: "inbox" });
        yield* a.push(account, "p", { kind: "trash" });
        yield* a.push(account, "p", { kind: "spam" });
        yield* a.push(account, "p", { kind: "label", labelId: "id-c1", value: true });
        yield* a.push(account, "p", { kind: "label", labelId: "id-c1", value: false });
        // Outlook has no "important" flag; nothing is sent.
        yield* a.push(account, "p", { kind: "important", value: true });
      }),
    );
    assert.deepStrictEqual(
      http.calls.map((c) => [c.method, c.body]),
      [
        ["PATCH", { isRead: true }],
        ["PATCH", { flag: { flagStatus: "notFlagged" } }],
        ["POST", { destinationId: "archive" }],
        ["POST", { destinationId: "inbox" }],
        ["POST", { destinationId: "deleteditems" }],
        ["POST", { destinationId: "junkemail" }],
        ["POST", { destinationId: "id-c1" }],
        ["POST", { destinationId: "inbox" }],
        ["PATCH", { importance: "high" }],
      ],
    );
  }),
);

it.effect("Graph creates child folders, renames and deletes without losing empty folders", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders": {
        json: {
          value: [{ id: "child", displayName: "Child", childFolderCount: 0, totalItemCount: 0 }],
        },
      },
      "POST /me/mailFolders/parent/childFolders": { json: { id: "child" } },
      "PATCH /me/mailFolders/child": { json: { id: "child" } },
      "DELETE /me/mailFolders/child": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const labels = yield* a.changeLabel(account, {
          kind: "create",
          name: "Child",
          parentId: "parent",
        });
        assert.strictEqual(labels[0]?.name, "Child");
        yield* a.changeLabel(account, { kind: "rename", id: "child", name: "Renamed" });
        yield* a.changeLabel(account, { kind: "delete", id: "child" });
      }),
    );
    assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
      displayName: "Child",
    });
    assert.deepStrictEqual(http.calls.find((c) => c.method === "PATCH")?.body, {
      displayName: "Renamed",
    });
  }),
);

it.effect(
  "Graph mutations return authoritative folder IDs and names while list endpoints still lag",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/mailFolders": {
          json: {
            value: [
              { id: "parent", displayName: "Projects", childFolderCount: 0, totalItemCount: 0 },
            ],
          },
        },
        "POST /me/mailFolders/parent/childFolders": {
          status: 201,
          json: { id: "new-folder", displayName: "Test" },
        },
        "PATCH /me/mailFolders/new-folder": { json: { id: "new-folder", displayName: "Renamed" } },
        "DELETE /me/mailFolders/new-folder": { status: 204 },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const created = yield* a.changeLabel(account, {
            kind: "create",
            parentId: "parent",
            name: "Test",
          });
          assert.deepStrictEqual(
            created.find((l) => l.id === "new-folder"),
            { id: "new-folder", name: "Projects/Test", color: null },
          );
          const renamed = yield* a.changeLabel(account, {
            kind: "rename",
            id: "new-folder",
            name: "Renamed",
          });
          assert.strictEqual(renamed.find((l) => l.id === "new-folder")?.name, "Projects/Renamed");
          const removed = yield* a.changeLabel(account, { kind: "delete", id: "new-folder" });
          assert.ok(!removed.some((l) => l.id === "new-folder"));
        }),
      );
    }),
);

it.effect("Graph folder creation does not depend on a follow-up listing to retain the new ID", () =>
  Effect.gen(function* () {
    let created = false;
    const http = fakeHttp({
      "GET /me/mailFolders": () =>
        created ? { status: 403, json: { error: "listing unavailable" } } : { json: { value: [] } },
      "POST /me/mailFolders": () => {
        created = true;
        return { status: 201, json: { id: "new-id", displayName: "New" } };
      },
    });
    const labels = yield* run(http, (a) => a.changeLabel(account, { kind: "create", name: "New" }));
    assert.deepStrictEqual(labels, [{ id: "new-id", name: "New", color: null }]);
    assert.strictEqual(http.calls.at(-1)?.method, "POST");
  }),
);

it.effect("folder actions follow Graph pages and POST permanentDelete with immutable ids", () => {
  const http = fakeHttp({
    "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
    "GET /me/mailFolders/deleteditems/messages": (url) => ({
      json: url.searchParams.has("$skip")
        ? { value: [{ id: "b" }] }
        : {
            value: [{ id: "a" }],
            "@odata.nextLink": `${GRAPH}/me/mailFolders/deleteditems/messages?$skip=1`,
          },
    }),
    "POST /me/messages/a/permanentDelete": { status: 204 },
    "POST /me/messages/b/permanentDelete": { status: 404 },
    "GET /me/mailFolders/deleteditems": { json: { id: "trash-root" } },
    "GET /me/mailFolders/trash-root/childFolders": { json: { value: [] } },
    "GET /me/messages/a": { json: { parentFolderId: "trash-root" } },
    "GET /me/messages/b": { json: { parentFolderId: "trash-root" } },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const folder = { mailbox: "trash" } as const;
      const first = yield* adapter.listFolderMessages(account, folder, null);
      assert.deepStrictEqual(first.ids, ["a"]);
      assert.deepStrictEqual(yield* adapter.listFolderMessages(account, folder, first.next), {
        ids: ["b"],
        next: null,
      });
      yield* adapter.permanentlyDelete(account, ["a", "b"], "trash");
      assert.strictEqual(
        http.calls.filter((c) => c.url.pathname.endsWith("permanentDelete")).length,
        2,
      );
      assert.ok(
        http.calls
          .filter((c) => c.url.pathname.endsWith("permanentDelete"))
          .every((c) => c.method === "POST" && c.prefer === 'IdType="ImmutableId"'),
      );
      for (const cursor of [
        "https://evil.example/v1.0/me/mailFolders/deleteditems/messages",
        `${GRAPH}/me/messages?$skip=2`,
      ])
        assert.isTrue(
          (yield* adapter.listFolderMessages(account, folder, cursor).pipe(Effect.result))._tag ===
            "Failure",
        );
      assert.isFalse(http.calls.some((c) => c.url.hostname === "evil.example"));
      assert.isTrue(
        (yield* adapter
          .permanentlyDelete(
            account,
            Array.from({ length: 101 }, () => "a"),
            "trash",
          )
          .pipe(Effect.result))._tag === "Failure",
      );
    }),
  );
});

it.effect(
  "Outlook unread enumeration filters server-side and empty Trash includes nested and hidden child folders",
  () => {
    const http = fakeHttp({
      "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /me/mailFolders/inbox/messages": (url) => {
        assert.strictEqual(url.searchParams.get("$filter"), "isRead eq false");
        return { json: { value: [{ id: "unread" }] } };
      },
      "GET /me/mailFolders/deleteditems/messages": { json: { value: [] } },
      "GET /me/mailFolders/deleteditems/childFolders": (url) => {
        if (url.searchParams.has("$skip")) return { json: { value: [] } };
        assert.strictEqual(url.searchParams.get("includeHiddenFolders"), "true");
        return {
          json: {
            value: [{ id: "child" }],
            "@odata.nextLink": `${GRAPH}/me/mailFolders/deleteditems/childFolders?$skip=1`,
          },
        };
      },
      "GET /me/mailFolders/child/messages": { json: { value: [] } },
      "GET /me/mailFolders/child/childFolders": { json: { value: [{ id: "nested" }] } },
      "GET /me/mailFolders/nested/messages": { json: { value: [{ id: "nested-mail" }] } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        yield* adapter.listFolderMessages(account, { mailbox: "inbox" }, null, {
          unreadOnly: true,
        });
        assert.deepStrictEqual(
          yield* adapter.listFolderMessages(account, { mailbox: "trash" }, null, {
            includeChildren: true,
          }),
          { ids: ["nested-mail"], next: null },
        );
      }),
    );
  },
);

it.effect("Outlook marks read with bounded concurrency and immutable IDs", () => {
  let active = 0;
  let maximum = 0;
  let count = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "PATCH") {
        active++;
        maximum = Math.max(maximum, active);
        assert.strictEqual(request.headers.prefer, 'IdType="ImmutableId"');
        yield* Effect.yieldNow;
        active--;
        count++;
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ access_token: "token", expires_in: 3600 }),
      );
    }),
  );
  return makeOutlook.pipe(
    Effect.flatMap((adapter) =>
      adapter.markReadBatch(
        account,
        Array.from({ length: 20 }, (_, i) => String(i)),
      ),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.strictEqual(count, 20);
        assert.isTrue(maximum > 1 && maximum <= 5);
      }),
    ),
    Effect.provide(
      Layer.mergeAll(Layer.succeed(HttpClient.HttpClient)(client), MemoryPlatform(platformOptions)),
    ),
  );
});

it.effect(
  "Graph verifies current parent folders, retains restored mail and returns only successful deletions",
  () => {
    const http = fakeHttp({
      "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /me/mailFolders/deleteditems": { json: { id: "trash-root" } },
      "GET /me/mailFolders/trash-root/childFolders": { json: { value: [{ id: "child" }] } },
      "GET /me/mailFolders/child/childFolders": { json: { value: [] } },
      "GET /me/messages/root": { json: { parentFolderId: "trash-root" } },
      "GET /me/messages/child": (url) => {
        assert.strictEqual(url.searchParams.get("$select"), "parentFolderId");
        return { json: { parentFolderId: "child" } };
      },
      "GET /me/messages/restored": { json: { parentFolderId: "inbox" } },
      "GET /me/messages/gone": { status: 404 },
      "POST /me/messages/root/permanentDelete": { status: 204 },
      "POST /me/messages/child/permanentDelete": { status: 204 },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* adapter.permanentlyDelete(account, ["root", "child", "restored", "gone"], "trash"),
          { kind: "complete", ids: ["root", "child"] },
        );
        assert.deepStrictEqual(
          http.calls
            .filter(
              (call) => call.method === "POST" && call.url.pathname.endsWith("permanentDelete"),
            )
            .map((call) => call.url.pathname),
          ["/v1.0/me/messages/root/permanentDelete", "/v1.0/me/messages/child/permanentDelete"],
        );
      }),
    );
  },
);

it.effect("Outlook mark-all-read continues after a snapshotted message disappears with 404", () => {
  const http = fakeHttp({
    "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
    "PATCH /me/messages/gone": { status: 404 },
    "PATCH /me/messages/live": { status: 204 },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.markReadBatch(account, ["gone", "live"]);
      assert.strictEqual(http.calls.filter((call) => call.method === "PATCH").length, 2);
    }),
  );
});

it.effect(
  "Graph moves a folder under a new parent and retains nested display paths until sync catches up",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/mailFolders": {
          json: {
            value: [
              { id: "parent", displayName: "Parent", childFolderCount: 0, totalItemCount: 0 },
              { id: "child", displayName: "Child", childFolderCount: 1, totalItemCount: 0 },
            ],
          },
        },
        "GET /me/mailFolders/child/childFolders": {
          json: {
            value: [
              { id: "nested", displayName: "Nested", childFolderCount: 0, totalItemCount: 0 },
            ],
          },
        },
        "POST /me/mailFolders/child/move": { json: { id: "moved-child" } },
      });
      const labels = yield* run(http, (a) =>
        a.changeLabel(account, { kind: "parent", id: "child", parentId: "parent" }),
      );
      assert.strictEqual(labels.find((l) => l.id === "moved-child")?.name, "Parent/Child");
      assert.strictEqual(
        labels.some((l) => l.id === "child"),
        false,
      );
      assert.strictEqual(labels.find((l) => l.id === "nested")?.name, "Parent/Child/Nested");
      assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
        destinationId: "parent",
      });
    }),
);

it.effect("opaque message and attachment IDs are encoded as individual Graph path segments", () =>
  Effect.gen(function* () {
    const id = "A/B+C==";
    const http = fakeHttp({
      "GET /me/messages/A%2FB%2BC%3D%3D": {
        json: { ...raw, id, parentFolderId: "inbox", hasAttachments: false },
      },
      "GET /me/mailFolders/inbox": { json: { id: "inbox", displayName: "Inbox" } },
    });
    yield* run(http, (adapter) => adapter.fetchMessage(account, id));
    assert.ok(http.calls.some((call) => call.url.pathname === "/v1.0/me/messages/A%2FB%2BC%3D%3D"));
    assert.ok(http.calls.every((call) => !call.url.pathname.includes("/messages/A/")));
  }),
);

it.effect("multi-category writes reread server categories and never move the message", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/A": { json: { categories: ["Keep", "Old", "Remote"] } },
      "GET /me/outlook/masterCategories": {
        json: { value: [{ displayName: "Work" }, { displayName: "Personal" }] },
      },
      "PATCH /me/messages/A": { json: {} },
    });
    yield* run(http, (adapter) =>
      adapter.push(account, "A", {
        kind: "categories",
        add: ["Work", "Personal", "Work"],
        remove: ["Old"],
      }),
    );
    assert.deepStrictEqual(
      http.calls.map((call) => [call.method, call.url.pathname]),
      [
        ["GET", "/v1.0/me/messages/A"],
        ["GET", "/v1.0/me/outlook/masterCategories"],
        ["PATCH", "/v1.0/me/messages/A"],
      ],
    );
    assert.deepStrictEqual(http.calls[2]?.body, {
      categories: ["Keep", "Remote", "Work", "Personal"],
    });
    assert.deepStrictEqual(
      parseGraphMessage({ ...raw, categories: ["Work", "Personal"] }, "INBOX", []).labels,
      ["INBOX", "category:Work", "category:Personal", "UNREAD", "STARRED"],
    );
  }),
);

it.effect(
  "category names compare case-insensitively and missing master names are created before assignment",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/messages/A": { json: { categories: ["Work", "OLD", "Keep"] } },
        "GET /me/outlook/masterCategories": { json: { value: [{ displayName: "Work" }] } },
        "POST /me/outlook/masterCategories": {
          json: { id: "new", displayName: "Personal" },
          status: 201,
        },
        "PATCH /me/messages/A": { json: {} },
      });
      yield* run(http, (adapter) =>
        adapter.push(account, "A", {
          kind: "categories",
          add: ["work", "Personal", "PERSONAL"],
          remove: ["old"],
        }),
      );
      assert.deepStrictEqual(
        http.calls.filter((call) => call.method === "POST").map((call) => call.body),
        [{ displayName: "Personal", color: "none" }],
      );
      assert.deepStrictEqual(http.calls.at(-1)?.body, { categories: ["Work", "Keep", "Personal"] });
    }),
);

it.effect("category registration failure never patches message categories", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/A": { json: { categories: ["Keep"] } },
      "GET /me/outlook/masterCategories": { json: { value: [] } },
      "POST /me/outlook/masterCategories": { status: 403 },
      "PATCH /me/messages/A": { json: {} },
    });
    const result = yield* Effect.result(
      run(http, (adapter) =>
        adapter.push(account, "A", { kind: "categories", add: ["Work"], remove: [] }),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.ok(!http.calls.some((call) => call.method === "PATCH"));
  }),
);

it.effect("empty Graph Trash walks key-segment child pages", () => {
  const next = `${GRAPH}/me/mailfolders('deleteditems')/childfolders?$skiptoken=next%2Fpage`;
  const http = fakeHttp({
    "GET /me/mailFolders/deleteditems/messages": { json: { value: [] } },
    "GET /me/mailFolders/deleteditems/childFolders": {
      json: { value: [], "@odata.nextLink": next },
    },
    "GET /me/mailfolders('deleteditems')/childfolders": { json: { value: [{ id: "child" }] } },
    "GET /me/mailFolders/child/messages": { json: { value: [{ id: "nested-mail" }] } },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* adapter.listFolderMessages(account, { mailbox: "trash" }, null, {
          includeChildren: true,
        }),
        { ids: ["nested-mail"], next: null },
      );
      assert.isTrue(http.calls.some((call) => call.url.href === next));
    }),
  );
});
