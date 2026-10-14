import { fakeHttp } from "../../platform/node/fake-http.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { account, run, labels } from "../../../test-support/gmail-fixtures.js";
it.live("invalid move destination never untrashes a Gmail message", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /messages/m": { json: { labelIds: ["TRASH"] } },
      "POST /messages/m/untrash": { json: {} },
      "POST /messages/m/modify": { status: 400 },
    });
    yield* run(http, (a) =>
      a
        .push(account, "m", { kind: "move", labelId: "missing", removeLabelId: null })
        .pipe(Effect.result),
    );
    assert.isFalse(http.calls.some((c) => c.url.pathname.endsWith("/untrash")));
  }),
);

it.live("failed Gmail move restores Trash after untrash", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: { labels: [{ id: "Label_dest", name: "Destination", type: "user" }] },
      },
      "GET /messages/m": { json: { labelIds: ["TRASH"] } },
      "POST /messages/m/untrash": { json: {} },
      "POST /messages/m/modify": { status: 400 },
      "POST /messages/m/trash": { json: {} },
    });
    yield* run(http, (a) =>
      a
        .push(account, "m", { kind: "move", labelId: "Label_dest", removeLabelId: null })
        .pipe(Effect.result),
    );
    assert.isTrue(http.calls.some((c) => c.url.pathname.endsWith("/trash")));
  }),
);

for (const status of [400, 409]) {
  it.live(`Gmail label create ${status} resolves the existing name`, () =>
    Effect.gen(function* () {
      let lists = 0;
      const http = fakeHttp({
        "GET /labels": () => ({
          json: { labels: lists++ ? [{ id: "Label_found", name: "Work", type: "user" }] : [] },
        }),
        "POST /labels": { status },
      });
      const labels = yield* run(http, (a) =>
        a.changeLabel(account, { kind: "create", name: "Work" }),
      );
      assert.strictEqual(labels[0]?.id, "Label_found");
    }),
  );
}

it.effect("ops map onto trash, untrash and label modifications", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /messages/p/trash": { json: {} },
      "POST /messages/p/untrash": { json: {} },
      "POST /messages/p/modify": { json: {} },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.push(account, "p", { kind: "trash" });
        yield* a.push(account, "p", { kind: "inbox" });
        yield* a.push(account, "p", { kind: "read", value: true });
        yield* a.push(account, "p", { kind: "label", labelId: "Label_1", value: false });
      }),
    );
    assert.deepStrictEqual(
      http.calls.map((c) => [c.url.pathname.split("/").at(-1), c.body]),
      [
        ["trash", undefined],
        ["untrash", undefined],
        ["modify", { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }],
        ["modify", { addLabelIds: [], removeLabelIds: ["UNREAD"] }],
        ["modify", { addLabelIds: [], removeLabelIds: ["Label_1"] }],
      ],
    );
  }),
);

it.effect("Gmail batch label changes use one batchModify request", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /messages/batchModify": { json: {} } });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const batch = adapter.pushBatch;
        assert.ok(batch);
        yield* batch(account, ["p", "q"], { kind: "read", value: true });
      }),
    );
    assert.strictEqual(http.calls.length, 1);
    assert.deepStrictEqual(http.calls[0]?.body, {
      ids: ["p", "q"],
      addLabelIds: [],
      removeLabelIds: ["UNREAD"],
    });
  }),
);

it.effect("Gmail manages label names and palette colors with the labels API", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "POST /labels": { json: {} },
      "PATCH /labels/Label_1": { json: {} },
      "DELETE /labels/Label_1": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.changeLabel(account, { kind: "create", parentId: "Label_1", name: "New" });
        yield* a.changeLabel(account, { kind: "rename", id: "Label_1", name: "Renamed" });
        yield* a.changeLabel(account, { kind: "color", id: "Label_1", color: "#4986e7" });
        yield* a.changeLabel(account, { kind: "delete", id: "Label_1" });
      }),
    );
    assert.deepStrictEqual(http.calls.filter((c) => c.method === "POST")[0]?.body, {
      name: "Clients/New",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    });
    assert.deepStrictEqual(
      http.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [{ name: "Renamed" }, { color: { backgroundColor: "#4986e7", textColor: "#000000" } }],
    );
  }),
);

it.effect(
  "folder actions enumerate ids with page tokens and use bounded permanent batch deletion",
  () => {
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("labelIds"), "TRASH");
        assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
        assert.strictEqual(url.searchParams.get("maxResults"), "100");
        return {
          json: url.searchParams.has("pageToken")
            ? { messages: [{ id: "b" }] }
            : { messages: [{ id: "a" }], nextPageToken: "next" },
        };
      },
      "POST /messages/batchDelete": { status: 204 },
      "GET /messages/a": { json: { labelIds: ["TRASH"] } },
      "GET /messages/b": { json: { labelIds: ["TRASH"] } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        const folder = { mailbox: "trash" } as const;
        const first = yield* adapter.listFolderMessages(account, folder, null);
        assert.deepStrictEqual(first, { ids: ["a"], next: "next" });
        assert.deepStrictEqual(yield* adapter.listFolderMessages(account, folder, first.next), {
          ids: ["b"],
          next: null,
        });
        yield* adapter.permanentlyDelete(account, ["a", "b"], "trash");
        assert.deepStrictEqual(
          http.calls.find((c) => c.url.pathname.endsWith("batchDelete"))?.body,
          { ids: ["a", "b"] },
        );
        assert.isTrue(
          (yield* adapter
            .permanentlyDelete(
              account,
              Array.from({ length: 101 }, () => "a"),
              "trash",
            )
            .pipe(Effect.result))._tag === "Failure",
        );
        assert.strictEqual(
          http.calls.filter((c) => c.url.pathname.endsWith("batchDelete")).length,
          1,
        );
      }),
    );
  },
);

it.effect(
  "folder enumeration intersects Inbox categories and excludes Trash and Spam from All Mail labels",
  () => {
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /messages": (url) => {
        const labels = url.searchParams.getAll("labelIds");
        if (labels.includes("CATEGORY_SOCIAL")) {
          assert.deepStrictEqual(labels, ["INBOX", "CATEGORY_SOCIAL"]);
        } else {
          assert.deepStrictEqual(labels, ["custom"]);
          assert.strictEqual(url.searchParams.get("q"), "-in:trash -in:spam");
        }
        return { json: {} };
      },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        yield* adapter.listFolderMessages(
          account,
          { mailbox: "inbox", label: "CATEGORY_SOCIAL" },
          null,
        );
        yield* adapter.listFolderMessages(account, { mailbox: "all", label: "custom" }, null);
      }),
    );
  },
);

it.effect("Gmail folder reads query UNREAD before enumerating and mark an entire ID batch", () => {
  const http = fakeHttp({
    "POST /token": { json: { access_token: "token", expires_in: 3600 } },
    "GET /messages": (url) => {
      assert.deepStrictEqual(url.searchParams.getAll("labelIds"), ["UNREAD"]);
      assert.strictEqual(url.searchParams.get("q"), "-in:trash -in:spam");
      return { json: { messages: [{ id: "unread" }] } };
    },
    "POST /messages/batchModify": { status: 204 },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const page = yield* adapter.listFolderMessages(account, { mailbox: "all" }, null, {
        unreadOnly: true,
      });
      yield* adapter.markReadBatch(account, page.ids);
      assert.deepStrictEqual(
        http.calls.find((call) => call.url.pathname.endsWith("batchModify"))?.body,
        { ids: ["unread"], addLabelIds: [], removeLabelIds: ["UNREAD"] },
      );
    }),
  );
});

it.effect(
  "Gmail checks current minimal labels for every id and returns only confirmed Trash or Spam deletions",
  () => {
    const metadata = (labels: string[]) => (url: URL) => {
      assert.strictEqual(url.searchParams.get("format"), "minimal");
      assert.strictEqual(url.searchParams.get("fields"), "labelIds");
      return { json: { labelIds: labels } };
    };
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /messages/trash": metadata(["TRASH"]),
      "GET /messages/restored": metadata(["INBOX"]),
      "GET /messages/spam": metadata(["SPAM"]),
      "GET /messages/gone": { status: 404 },
      "POST /messages/batchDelete": { status: 204 },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* adapter.permanentlyDelete(account, ["trash", "restored", "gone"], "trash"),
          { kind: "complete", ids: ["trash"] },
        );
        assert.deepStrictEqual(
          yield* adapter.permanentlyDelete(account, ["spam", "restored"], "spam"),
          { kind: "complete", ids: ["spam"] },
        );
        assert.deepStrictEqual(
          http.calls
            .filter((call) => call.url.pathname.endsWith("batchDelete"))
            .map((call) => call.body),
          [{ ids: ["trash"] }, { ids: ["spam"] }],
        );
      }),
    );
  },
);

it.effect(
  "Gmail Move To adds the destination and removes the current label in one modify request",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /messages/m1": { json: { labelIds: ["INBOX"] } },
        "POST /messages/m1/modify": { json: {} },
      });
      yield* run(http, (a) =>
        a.push(account, "m1", { kind: "move", labelId: "Label_2", removeLabelId: "INBOX" }),
      );
      assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 1);
      assert.deepStrictEqual(http.calls.at(-1)?.body, {
        addLabelIds: ["Label_2"],
        removeLabelIds: ["INBOX", "SPAM"],
      });
    }),
);

it.effect("Gmail label visibility is read and PATCHed; reparenting renames descendants", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: {
          labels: [
            {
              id: "a",
              name: "A",
              type: "user",
              labelListVisibility: "labelHide",
              messageListVisibility: "hide",
            },
            { id: "child", name: "A/Child", type: "user" },
            { id: "b", name: "B", type: "user" },
          ],
        },
      },
      "PATCH /labels/a": { json: {} },
      "PATCH /labels/child": { json: {} },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const labels = yield* a.changeLabel(account, {
          kind: "visibility",
          id: "a",
          labelListVisibility: "labelShowIfUnread",
          messageListVisibility: "show",
        });
        assert.strictEqual(labels[0]?.labelListVisibility, "labelHide");
        assert.strictEqual(labels[0]?.messageListVisibility, "hide");
        yield* a.changeLabel(account, { kind: "parent", id: "a", parentId: "b" });
      }),
    );
    assert.deepStrictEqual(
      http.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [
        { labelListVisibility: "labelShowIfUnread", messageListVisibility: "show" },
        { name: "B/A" },
        { name: "B/A/Child" },
      ],
    );
  }),
);

for (const source of ["TRASH", "SPAM"] as const) {
  it.effect(`Gmail Move To from ${source} clears the system label in single and batch paths`, () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /labels": { json: { labels: [{ id: "Label_target", name: "Target", type: "user" }] } },
        "GET /messages/m1": { json: { labelIds: [source] } },
        "POST /messages/m1/untrash": { json: {} },
        "POST /messages/m1/modify": { json: {} },
      });
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          const op = { kind: "move", labelId: "Label_target", removeLabelId: null } as const;
          yield* adapter.push(account, "m1", op);
          assert.ok(adapter.pushBatch);
          yield* adapter.pushBatch(account, ["m1"], op);
        }),
      );
      const posts = http.calls.filter((call) => call.method === "POST");
      assert.strictEqual(
        posts.filter((call) => call.url.pathname.endsWith("/untrash")).length,
        source === "TRASH" ? 2 : 0,
      );
      const modifications = posts.filter((call) => call.url.pathname.endsWith("/modify"));
      assert.strictEqual(modifications.length, 2);
      for (const call of modifications)
        assert.deepStrictEqual(call.body, {
          addLabelIds: ["Label_target"],
          removeLabelIds: ["SPAM"],
        });
    }),
  );
}

for (const collision of ["B/A", "B/A/Child"]) {
  it.effect(`Gmail reparent checks ${collision} for collisions before any PATCH`, () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /labels": {
          json: {
            labels: [
              { id: "a", name: "A", type: "user" },
              { id: "child", name: "A/Child", type: "user" },
              { id: "b", name: "B", type: "user" },
              { id: "collision", name: collision, type: "user" },
            ],
          },
        },
      });
      const exit = yield* run(http, (adapter) =>
        adapter.changeLabel(account, { kind: "parent", id: "a", parentId: "b" }),
      ).pipe(Effect.result);
      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(
        http.calls.some((call) => call.method === "PATCH"),
        false,
      );
    }),
  );
}

it.effect("Gmail reparent rolls back already-renamed labels on a descendant failure", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: {
          labels: [
            { id: "a", name: "A", type: "user" },
            { id: "child", name: "A/Child", type: "user" },
            { id: "b", name: "B", type: "user" },
          ],
        },
      },
      "PATCH /labels/a": { json: {} },
      "PATCH /labels/child": { status: 400, json: { error: "rename refused" } },
    });
    const exit = yield* run(http, (adapter) =>
      adapter.changeLabel(account, { kind: "parent", id: "a", parentId: "b" }),
    ).pipe(Effect.result);
    assert.strictEqual(exit._tag, "Failure");
    assert.deepStrictEqual(
      http.calls.filter((call) => call.method === "PATCH").map((call) => call.body),
      [{ name: "B/A" }, { name: "B/A/Child" }, { name: "A" }],
    );
  }),
);
