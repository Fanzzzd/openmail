import { assert, it } from "@effect/vitest";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { incoming } from "../../platform/node/testing.js";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { makeOutlook } from "./outlook.js";
import { parseGraphMessage } from "./parse.js";
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
  WELL_KNOWN,
  mailbox,
  tags,
} from "../../../test-support/outlook-fixtures.js";
import { scaledMs } from "../../../test-support/test-time.js";
it.effect("inbox polling follows only its delta and skips folder discovery", () =>
  Effect.gen(function* () {
    const inbox = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=before`;
    const next = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=after`;
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messages/delta": {
        json: { value: [{ ...raw, hasAttachments: false }], "@odata.deltaLink": next },
      },
    });
    const cursor = JSON.stringify({ __idType: "immutable", inbox, sentitems: "unrelated" });
    const changes = yield* run(http, (adapter) =>
      Stream.runCollect(adapter.pull(account, Option.some(cursor), "inbox")),
    );
    assert.deepStrictEqual(tags(changes), ["Upsert", "Progress", "Cursor"]);
    assert.strictEqual(http.calls.length, 1);
    assert.strictEqual(http.calls[0]?.url.toString(), inbox);
    assert.deepStrictEqual(changes.at(-1), {
      _tag: "Cursor",
      cursor: JSON.stringify({ __idType: "immutable", inbox: next }),
    });
  }),
);

for (const mailbox of ["all", "starred", "important"] as const) {
  it.effect(`Outlook ${mailbox} history paging avoids Graph InefficientFilter`, () => {
    const http = fakeHttp({
      "GET /me/mailFolders/junkemail": { json: { id: "junk" } },
      "GET /me/mailFolders/deleteditems": { json: { id: "trash" } },
      "GET /me/messages": (url) => {
        if (
          url.searchParams.has("$orderby") &&
          !url.searchParams.get("$filter")?.startsWith("receivedDateTime ge ")
        )
          return {
            status: 400,
            json: {
              error: { code: "InefficientFilter", message: "Order property must start filter" },
            },
          };
        return { json: { value: [{ id: "older" }] } };
      },
    });
    return run(http, (adapter) =>
      adapter
        .listFolderMessages(account, { mailbox }, null, { newestFirst: true })
        .pipe(Effect.tap((page) => Effect.sync(() => assert.deepStrictEqual(page.ids, ["older"])))),
    );
  });
}

it.effect("Outlook sync health GETs the exact system/custom folder count selection", () => {
  const http = fakeHttp({
    "GET /me/mailFolders/inbox": { json: { totalItemCount: 12, unreadItemCount: 3 } },
    "GET /me/mailFolders/folder-id": { json: { totalItemCount: 4, unreadItemCount: 0 } },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* adapter.folderStatus(account, "INBOX"), {
        total: 12,
        unread: 3,
        threads: null,
        uidNext: null,
        uidValidity: null,
      });
      assert.strictEqual((yield* adapter.folderStatus(account, "folder-id")).total, 4);
      const calls = http.calls.filter((call) => call.url.hostname === "graph.microsoft.com");
      assert.strictEqual(calls.length, 2);
      for (const call of calls) {
        assert.strictEqual(call.method, "GET");
        assert.strictEqual(call.url.searchParams.get("$select"), "totalItemCount,unreadItemCount");
      }
    }),
  );
});

for (const firstStatus of [200, 403]) {
  it.effect(
    `a move from later-processed Drafts to Inbox resolves via a durable conflict queue (${firstStatus})`,
    () => {
      let status = firstStatus;
      let pulling = true;
      const http = fakeHttp({
        ...mailbox({
          inbox: {
            json: {
              value: [{ ...raw, id: "moving", isDraft: false, hasAttachments: false }],
              "@odata.deltaLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=2`,
            },
          },
          drafts: (url) =>
            url.searchParams.has("$skiptoken")
              ? {
                  json: {
                    value: [{ id: "moving", "@removed": { reason: "deleted" } }],
                    "@odata.deltaLink": `${GRAPH}/me/mailFolders/drafts/messages/delta?$deltatoken=2`,
                  },
                }
              : {
                  json: {
                    value: [{ ...raw, id: "moving", isDraft: true, hasAttachments: false }],
                    "@odata.nextLink": `${GRAPH}/me/mailFolders/drafts/messages/delta?$skiptoken=next`,
                  },
                },
        }),
        "POST /$batch": () => {
          assert.isFalse(
            pulling,
            "conflict verification must happen after pull, through the guard",
          );
          return {
            json: {
              responses: [{ id: "0", status, body: { id: "moving", parentFolderId: "id-inbox" } }],
            },
          };
        },
      });
      const services = Layer.mergeAll(
        StoreLive,
        Layer.effect(
          Providers,
          makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter }))),
        ),
      ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
      return Effect.gen(function* () {
        const store = yield* Store,
          providers = yield* Providers,
          mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", account.email);
        const cursor = JSON.stringify({
          __idType: "immutable",
          inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=1`,
          drafts: `${GRAPH}/me/mailFolders/drafts/messages/delta?$deltatoken=1`,
        });
        const changes = yield* Stream.runCollect(
          providers.get("outlook").pull(saved, Option.some(cursor)),
        );
        assert.include(tags(changes), "VerifyCandidates");
        assert.isFalse(http.calls.some((c) => c.url.pathname.endsWith("/$batch")));
        pulling = false;
        yield* store.saveSyncCursor(saved.id, cursor);
        yield* mailbox.sync.sync(saved.id);
        if (status === 403) {
          assert.deepStrictEqual(
            (yield* store.pendingResetCandidates(saved.id)).map((c) => c.providerId),
            ["moving"],
          );
          assert.strictEqual(
            yield* store.messageIdForProvider(saved.id, "moving"),
            `${saved.id}/moving`,
          );
          status = 200;
          yield* mailbox.sync.sync(saved.id);
        }
        const current = yield* store.getMessage(`${saved.id}/moving`);
        assert.include(current.labels, "INBOX");
        assert.notInclude(current.labels, "DRAFT");
        assert.deepStrictEqual(yield* store.pendingResetCandidates(saved.id), []);
      }).pipe(
        Effect.provide(
          MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
            Layer.provideMerge(services),
          ),
        ),
      );
    },
  );
}

for (const status of [200, 404] as const) {
  it.effect(
    `an old message moved into a newer filtered folder is verified, not deleted (${status})`,
    () => {
      const link = (key: string) =>
        `${GRAPH}/me/mailFolders/${key}/messages/delta?$deltatoken=${key}`;
      // id-c1 was created in June. Its delta filter starts in June, so it never lists
      // the February message that the Inbox delta reports as removed.
      const http = fakeHttp({
        ...mailbox({
          inbox: {
            json: {
              value: [{ id: "feb", "@removed": { reason: "changed" } }],
              "@odata.deltaLink": link("inbox"),
            },
          },
        }),
        "POST /$batch": {
          json: {
            responses: [
              status === 200
                ? { id: "0", status, body: { id: "feb", parentFolderId: "id-c1" } }
                : { id: "0", status },
            ],
          },
        },
      });
      const services = Layer.mergeAll(
        StoreLive,
        Layer.effect(
          Providers,
          makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter }))),
        ),
      ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
      return Effect.gen(function* () {
        const store = yield* Store,
          providers = yield* Providers,
          mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", account.email);
        const cursor = JSON.stringify({
          __idType: "immutable",
          ...Object.fromEntries([...WELL_KNOWN, "id-c1", "id-c2"].map((k) => [k, link(k)])),
        });
        yield* store.upsertMessage(
          saved.id,
          incoming("feb", {
            subject: "February invoice",
            date: Date.parse("2026-02-10T09:00:00Z"),
            labels: ["INBOX", "STARRED"],
            isUnread: false,
            isStarred: true,
          }),
        );
        const changes = yield* Stream.runCollect(
          providers.get("outlook").pull(saved, Option.some(cursor)),
        );
        assert.notInclude(tags(changes), "Delete");
        assert.deepStrictEqual(
          changes.find((change) => change._tag === "VerifyCandidates"),
          { _tag: "VerifyCandidates", providerIds: ["feb"] },
        );
        yield* store.saveSyncCursor(saved.id, cursor);
        yield* mailbox.sync.sync(saved.id);
        const id = yield* store.messageIdForProvider(saved.id, "feb");
        assert.deepStrictEqual(yield* store.pendingResetCandidates(saved.id), []);
        if (status === 404) {
          assert.strictEqual(id, null);
          return;
        }
        assert.strictEqual(id, `${saved.id}/feb`);
        const moved = yield* store.getMessage(`${saved.id}/feb`);
        assert.deepStrictEqual(moved.labels.toSorted(), ["STARRED", "id-c1"]);
        const found = yield* store.listThreads({ search: "February invoice" });
        assert.deepStrictEqual(
          found.map((thread) => thread.subject),
          ["February invoice"],
        );
      }).pipe(
        Effect.provide(
          MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
            Layer.provideMerge(services),
          ),
        ),
      );
    },
  );
}

for (const { local, syncs } of [
  { local: 500, syncs: [500] },
  { local: 3000, syncs: [2000, 1000] },
]) {
  it.effect(
    `a bulk server delete of 5000 messages with ${local} stored clears in ${syncs.length} sync(s)`,
    () => {
      const link = (key: string) =>
        `${GRAPH}/me/mailFolders/${key}/messages/delta?$deltatoken=${key}`;
      const removed = Array.from({ length: 5000 }, (_, index) => `gone-${index}`);
      // The stored rows are spread through the removals, as recent mail is among old mail.
      const stored = removed.filter((_, index) => (index * local) % 5000 < local);
      const verified: string[][] = [];
      const http = fakeHttp({
        ...mailbox({
          inbox: {
            json: {
              value: removed.map((id) => ({ id, "@removed": { reason: "deleted" } })),
              "@odata.deltaLink": link("inbox"),
            },
          },
        }),
        "POST /$batch": (_url, call) => {
          const { requests } = Schema.decodeUnknownSync(
            Schema.Struct({
              requests: Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })),
            }),
          )(call.body);
          // Header backfill shares $batch; presence probes select only the folder.
          verified
            .at(-1)
            ?.push(
              ...requests.flatMap((request) =>
                request.url.endsWith("$select=id,parentFolderId") ? [request.url] : [],
              ),
            );
          return {
            json: { responses: requests.map((request) => ({ id: request.id, status: 404 })) },
          };
        },
      });
      const services = Layer.mergeAll(
        StoreLive,
        Layer.effect(
          Providers,
          makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter }))),
        ),
      ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
      return Effect.gen(function* () {
        const store = yield* Store,
          mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", account.email);
        yield* store.saveSyncCursor(
          saved.id,
          JSON.stringify({
            __idType: "immutable",
            ...Object.fromEntries([...WELL_KNOWN, "id-c1", "id-c2"].map((k) => [k, link(k)])),
          }),
        );
        yield* store.transaction(
          Effect.forEach(stored, (id) => store.upsertMessage(saved.id, incoming(id)), {
            discard: true,
          }),
        );
        for (const expected of syncs) {
          verified.push([]);
          yield* mailbox.sync.sync(saved.id);
          assert.strictEqual(verified.at(-1)?.length, expected);
        }
        // Only stored rows were verified, and each once.
        assert.strictEqual(verified.flat().length, local);
        assert.strictEqual(new Set(verified.flat()).size, local);
        assert.deepStrictEqual(yield* store.pendingResetCandidates(saved.id), []);
        for (const id of stored)
          assert.strictEqual(yield* store.messageIdForProvider(saved.id, id), null);
      }).pipe(
        Effect.provide(
          MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
            Layer.provideMerge(services),
          ),
        ),
      );
    },
    scaledMs(60_000),
  );
}

it.effect("an inbox poll spends one delta request, whatever the number of custom folders", () => {
  const link = (key: string) => `${GRAPH}/me/mailFolders/${key}/messages/delta?$deltatoken=${key}`;
  const custom = Array.from({ length: 100 }, (_, index) => `id-f${index}`);
  const http = fakeHttp(mailbox({}));
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const changes = yield* Stream.runCollect(
        adapter.pull(
          account,
          Option.some(
            JSON.stringify({
              __idType: "immutable",
              ...Object.fromEntries([...WELL_KNOWN, ...custom].map((k) => [k, link(k)])),
            }),
          ),
          "inbox",
        ),
      );
      assert.deepStrictEqual(
        http.calls.map((call) => `${call.method} ${call.url.pathname}`),
        ["GET /v1.0/me/mailFolders/inbox/messages/delta"],
      );
      const cursor = changes.findLast((change) => change._tag === "Cursor");
      assert.ok(cursor?._tag === "Cursor");
      assert.deepStrictEqual(Object.keys(JSON.parse(cursor.cursor)).toSorted(), [
        "__idType",
        "inbox",
      ]);
    }),
  );
});

for (const status of [200, 403, 404] as const) {
  it.effect(`an unlisted Graph folder is removed only after GET confirms 404 (${status})`, () => {
    const link = `${GRAPH}/me/mailFolders/id-old/messages/delta?token=old`;
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/mailFolders/id-old": {
        status,
        json: status === 200 ? { id: "id-old" } : undefined,
      },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        const changes = yield* Stream.runCollect(
          adapter.pull(
            account,
            Option.some(JSON.stringify({ __idType: "immutable", "id-old": link })),
          ),
        );
        assert.strictEqual(
          changes.some((change) => change._tag === "DeleteLabel" && change.label === "id-old"),
          status === 404,
        );
        const cursor = changes.findLast((change) => change._tag === "Cursor");
        assert.ok(cursor?._tag === "Cursor");
        const saved = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
          JSON.parse(cursor.cursor),
        );
        assert.strictEqual(saved["id-old"], status === 404 ? undefined : link);
        assert.isTrue(
          http.calls.some((call) => call.url.pathname === "/v1.0/me/mailFolders/id-old"),
        );
      }),
    );
  });
}

it.effect("Graph message and child-folder pages accept key segments unchanged", () => {
  const messagesNext = `${GRAPH}/me/mailfolders('actual-trash-id')/messages?$skiptoken=a%2Fb%2B%3D`;
  const childrenNext = `${GRAPH}/me/mailfolders('trash-root')/childfolders?$skiptoken=child%2Fnext`;
  const http = fakeHttp({
    "GET /me/mailFolders/deleteditems/messages": {
      json: { value: [{ id: "first" }], "@odata.nextLink": messagesNext },
    },
    "GET /me/mailfolders('actual-trash-id')/messages": { json: { value: [{ id: "second" }] } },
    "GET /me/mailFolders/deleteditems": { json: { id: "trash-root" } },
    "GET /me/mailFolders/trash-root/childFolders": {
      json: { value: [], "@odata.nextLink": childrenNext },
    },
    "GET /me/mailfolders('trash-root')/childfolders": { json: { value: [{ id: "child" }] } },
    "GET /me/mailFolders/child/childFolders": { json: { value: [] } },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const first = yield* adapter.listFolderMessages(account, { mailbox: "trash" }, null);
      assert.deepStrictEqual(
        (yield* adapter.listFolderMessages(account, { mailbox: "trash" }, first.next)).ids,
        ["second"],
      );
      assert.deepStrictEqual(yield* adapter.checkPermanentDelete(account, "trash"), [
        "TRASH",
        "trash-root",
        "child",
      ]);
      for (const next of [messagesNext, childrenNext])
        assert.isTrue(http.calls.some((call) => call.url.href === next));
    }),
  );
});

it.effect("Outlook Drafts undercounts are checked against collection count", () => {
  const http = fakeHttp({
    "GET /me/mailFolders/drafts": { json: { totalItemCount: 0, unreadItemCount: 0 } },
    "GET /me/mailFolders/drafts/messages": (url) => {
      assert.strictEqual(url.searchParams.get("$count"), "true");
      assert.strictEqual(url.searchParams.get("$select"), "id");
      assert.strictEqual(url.searchParams.get("$top"), "1");
      return { json: { "@odata.count": url.searchParams.has("$filter") ? 0 : 40, value: [] } };
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* adapter.folderStatus(account, "DRAFT", {
          localTotal: 40,
          summary: yield* adapter.folderStatus(account, "DRAFT"),
        })).total,
        40,
      );
      assert.isFalse(http.calls.some((call) => call.method === "POST"));
    }),
  );
});

it.effect("an unsupported Drafts count recheck preserves the available summary", () => {
  const http = fakeHttp({
    "GET /me/mailFolders/drafts": { json: { totalItemCount: 10, unreadItemCount: 1 } },
    "GET /me/mailFolders/drafts/messages": { status: 400 },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const summary = yield* adapter.folderStatus(account, "DRAFT");
      assert.deepStrictEqual(
        yield* adapter.folderStatus(account, "DRAFT", { localTotal: 40, summary }),
        summary,
      );
      assert.strictEqual(http.calls.length, 2);
    }),
  );
});

for (const partial of ["omitted", "signed", "complete"] as const) {
  it.effect(
    partial === "complete"
      ? "complete search metadata can clear a previously known attachment list"
      : `search with ${partial} attachment metadata preserves cached PDFs and reader hydration writes the full list`,
    () => {
      const pdf = { filename: "report.pdf", mimeType: "application/pdf", size: 12 };
      const added = { filename: "updated.pdf", mimeType: "application/pdf", size: 24 };
      const graph = {
        ...raw,
        id: "cached-pdf",
        subject: "attachment-preservation",
        parentFolderId: "id-inbox",
        hasAttachments: true,
      };
      const fullAttachments = [pdf, added];
      const expanded = fullAttachments.map((attachment) => ({
        name: attachment.filename,
        contentType: attachment.mimeType,
        size: attachment.size,
        isInline: false,
      }));
      const http = fakeHttp({
        ...mailbox({}),
        "GET /me/messages": {
          json: {
            value: [
              {
                ...graph,
                ...(partial === "complete" ? { hasAttachments: false, attachments: [] } : {}),
                ...(partial === "signed"
                  ? {
                      internetMessageHeaders: [
                        {
                          name: "Content-Type",
                          value: "application/pkcs7-mime; smime-type=signed-data",
                        },
                      ],
                      attachments: [
                        {
                          name: "smime.p7m",
                          contentType: "application/pkcs7-mime",
                          size: 100,
                          isInline: false,
                        },
                      ],
                    }
                  : {}),
              },
            ],
          },
        },
        "GET /me/messages/cached-pdf": {
          json: {
            ...graph,
            attachments: expanded,
            body: { contentType: "text", content: "Full reader body" },
          },
        },
      });
      const adapters = Layer.effect(
        Providers,
        Effect.map(makeOutlook, (adapter) => Providers.of({ get: () => adapter })),
      );
      const layer = MailboxLive({ backgroundFlush: false }).pipe(
        Layer.provideMerge(Layer.mergeAll(StoreLive, adapters)),
        Layer.provide(Layer.mergeAll(MemoryPlatform(platformOptions), http.layer)),
      );
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", account.email);
        const id = `${saved.id}/${graph.id}`;
        yield* store.upsertMessage(saved.id, parseGraphMessage(graph, "INBOX", [pdf]));
        const search = yield* mailbox.reading.searchServer({
          search: "attachment-preservation",
          accountIds: [saved.id],
          searchScope: "all",
        });
        assert.deepStrictEqual(search.errors, []);
        const afterSearch = yield* store.getMessage(id);
        assert.strictEqual(afterSearch.bodyCached, partial === "complete");
        assert.deepStrictEqual(afterSearch.attachments, partial === "complete" ? [] : [pdf]);
        assert.isFalse(
          http.calls.some(
            (call) =>
              call.url.pathname.endsWith("/attachments") || call.url.pathname.endsWith("/$value"),
          ),
        );
        const hydrated = (yield* mailbox.reading.readerThread(id)).find(
          (message) => message.id === id,
        );
        assert.ok(hydrated);
        assert.deepStrictEqual(hydrated.attachments, partial === "complete" ? [] : fullAttachments);
        if (partial !== "complete") assert.strictEqual(hydrated.bodyText, "Full reader body");
        assert.isTrue(hydrated.bodyCached);
        assert.deepStrictEqual(
          (yield* store.getMessage(id)).attachments,
          partial === "complete" ? [] : fullAttachments,
        );
      }).pipe(Effect.provide(layer));
    },
  );
}
