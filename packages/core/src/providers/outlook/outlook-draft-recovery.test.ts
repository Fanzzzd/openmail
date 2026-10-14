import { assert, it } from "@effect/vitest";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { incoming } from "../../platform/node/testing.js";
import { Clock, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import type { OutgoingMessage } from "../../domain/changes.js";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { makeOutlook } from "./outlook.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { isDefiniteSendFailure } from "../provider-send.js";
import { Providers } from "../adapter.js";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";
import {
  GRAPH,
  account,
  platformOptions,
  run,
  draftMessage,
} from "../../../test-support/outlook-fixtures.js";
it.effect(
  "discarding an uncertain Outlook creation removes its actual server copy by journal identity",
  () => {
    let copyExists = false;
    let cleanup = false;
    const http = fakeHttp({
      "POST /me/messages": () => {
        copyExists = true;
        return { status: 503 };
      },
      "GET /me/mailFolders/drafts/messages": (url) => ({
        json: {
          value:
            copyExists &&
            cleanup &&
            (url.searchParams.get("$filter") ?? "").includes("isDraft eq true")
              ? [{ id: "uncertain-copy" }]
              : [],
        },
      }),
      "DELETE /me/messages/uncertain-copy": () => {
        copyExists = false;
        return { status: 204 };
      },
    });
    const services = Layer.mergeAll(
      StoreLive,
      Layer.effect(Providers, makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter })))),
    ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
    return Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      const saved = yield* store.upsertAccount("outlook", account.email);
      yield* mailbox.compose.saveDraft({
        id: "discard-uncertain",
        accountId: saved.id,
        message: { ...draftMessage, attachments: [] },
      });
      assert.isTrue(copyExists);
      assert.isTrue(
        Option.getOrThrow(yield* store.draftCreateState("discard-uncertain")).attempted,
      );
      cleanup = true;
      yield* mailbox.compose.discardDraft("discard-uncertain");
      assert.isFalse(copyExists);
      assert.isTrue(Option.isNone(yield* store.getDraft("discard-uncertain")));
      assert.isTrue(Option.isNone(yield* store.draftCreateState("discard-uncertain")));
      assert.strictEqual(http.calls.filter((call) => call.method === "DELETE").length, 1);
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(Layer.provideMerge(services)),
      ),
    );
  },
);

for (const mode of ["reply", "forward"] as const) {
  for (const action of ["discard", "send", "retry"] as const) {
    it.effect(
      `${action} uncertain Outlook ${mode} preserves a unique single-save draft from another client`,
      () => {
        let visible = false;
        let foreignBody = "Reply already written on another device";
        let foreignExists = true;
        const foreign = {
          id: "foreign",
          conversationId: "conversation",
          isDraft: true,
          createdDateTime: new Date(1000).toISOString(),
          lastModifiedDateTime: new Date(1000).toISOString(),
          body: { contentType: "text", content: foreignBody },
        };
        const http = fakeHttp({
          [`POST /me/messages/source/${mode === "reply" ? "createReply" : "createForward"}`]: () =>
            visible ? { json: { id: "our-copy" } } : { status: 503 },
          "GET /me/messages/source": { json: { conversationId: "conversation" } },
          "GET /me/mailFolders/drafts/messages": (url) => ({
            json: {
              value:
                visible && !(url.searchParams.get("$filter") ?? "").startsWith("internetMessageId")
                  ? [foreign]
                  : [],
            },
          }),
          "PATCH /me/messages/our-copy": { json: { id: "our-copy" } },
          "POST /me/messages/our-copy/send": { status: 202 },
          "GET /me/messages/our-copy/attachments": { json: { value: [] } },
          "PATCH /me/messages/foreign": () => {
            foreignBody = "overwritten";
            return { json: { id: "foreign" } };
          },
          "DELETE /me/messages/foreign": () => {
            foreignExists = false;
            return { status: 204 };
          },
          "GET /me/messages/foreign/attachments": { json: { value: [] } },
        });
        const services = Layer.mergeAll(
          StoreLive,
          Layer.effect(
            Providers,
            makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter }))),
          ),
        ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
        return Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const saved = yield* store.upsertAccount("outlook", account.email);
          yield* store.upsertMessage(saved.id, incoming("source", { threadId: "conversation" }));
          const input = {
            id: "uncertain",
            accountId: saved.id,
            message: { ...draftMessage, attachments: [], mode, inReplyTo: `${saved.id}/source` },
          };
          yield* mailbox.compose.saveDraft(input);
          assert.isTrue(Option.getOrThrow(yield* store.draftCreateState(input.id)).attempted);
          visible = true;
          if (action === "retry") {
            yield* TestClock.adjust("2 minutes");
            for (let attempt = 0; attempt < 3; attempt++) yield* mailbox.compose.saveDraft(input);
            assert.strictEqual(
              Option.getOrThrow(yield* store.getDraft(input.id)).remote?.messageId,
              "our-copy",
            );
          } else {
            yield* action === "discard"
              ? mailbox.compose.discardDraft(input.id)
              : mailbox.organize.perform(
                  { kind: "send", accountId: saved.id, draftId: input.id, message: input.message },
                  { kind: "user", surface: "app" },
                );
            assert.isTrue(Option.isNone(yield* store.getDraft(input.id)));
          }
          assert.isTrue(foreignExists);
          assert.strictEqual(foreignBody, foreign.body.content);
          assert.isFalse(http.calls.some((call) => call.url.pathname.includes("/foreign")));
          assert.isFalse(
            http.calls.some((call) =>
              (call.url.searchParams.get("$filter") ?? "").includes("conversationId"),
            ),
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
  for (const action of ["discard", "send"] as const) {
    for (const scenario of ["kept", "missing", "ambiguous", "paginated"] as const) {
      it.effect(`${action} uncertain Outlook ${mode}: exact Message-ID ${scenario}`, () => {
        let cleanup = false;
        const candidate = {
          id: "our-copy",
          conversationId: "server-conversation",
          createdDateTime: new Date(-86400000).toISOString(),
          lastModifiedDateTime: new Date(86400000).toISOString(),
          isDraft: true,
        };
        const http = fakeHttp({
          [`POST /me/messages/source/${mode === "reply" ? "createReply" : "createForward"}`]: () =>
            cleanup ? { json: { id: "send-copy" } } : { status: 503 },
          "PATCH /me/messages/send-copy": { status: 200 },
          "POST /me/messages/send-copy/send": { status: 202 },
          "GET /me/messages/source": { json: { conversationId: "conversation" } },
          "GET /me/mailFolders/drafts/messages": (url) => {
            assert.include(url.searchParams.get("$filter") ?? "", "internetMessageId eq '");
            return {
              json: {
                value:
                  !cleanup || scenario === "missing"
                    ? []
                    : scenario === "ambiguous"
                      ? [candidate, { ...candidate, id: "second-copy" }]
                      : [candidate],
                ...(cleanup && scenario === "paginated"
                  ? { "@odata.nextLink": `${GRAPH}/me/mailFolders/drafts/messages?$skiptoken=more` }
                  : {}),
              },
            };
          },
          "DELETE /me/messages/our-copy": { status: 204 },
        });
        const services = Layer.mergeAll(
          StoreLive,
          Layer.effect(
            Providers,
            makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter }))),
          ),
        ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
        return Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const saved = yield* store.upsertAccount("outlook", account.email);
          yield* store.upsertMessage(saved.id, incoming("source", { threadId: "conversation" }));
          const input = {
            id: "uncertain",
            accountId: saved.id,
            message: { ...draftMessage, attachments: [], mode, inReplyTo: `${saved.id}/source` },
          };
          yield* mailbox.compose.saveDraft(input);
          cleanup = true;
          yield* action === "discard"
            ? mailbox.compose.discardDraft(input.id)
            : mailbox.organize.perform(
                { kind: "send", accountId: saved.id, draftId: input.id, message: input.message },
                { kind: "user", surface: "app" },
              );
          assert.strictEqual(
            http.calls.filter((call) => call.method === "DELETE").length,
            scenario === "kept" ? 1 : 0,
          );
          assert.isTrue(Option.isNone(yield* store.getDraft(input.id)));
        }).pipe(
          Effect.provide(
            MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
              Layer.provideMerge(services),
            ),
          ),
        );
      });
    }
  }
}

for (const exists of [false, true]) {
  it.effect(
    `Outlook uncertain-draft cleanup finds the journal Message-ID (${exists ? "found" : "missing"})`,
    () => {
      const http = fakeHttp({
        "GET /me/mailFolders/drafts/messages": (url) => {
          assert.include(
            url.searchParams.get("$filter") ?? "",
            "internetMessageId eq '<orphan@example.test>'",
          );
          return { json: { value: exists ? [{ id: "orphan" }] : [] } };
        },
        "DELETE /me/messages/orphan": { status: 204 },
      });
      return run(http, (adapter) =>
        adapter.deleteDraft(account, {
          draftId: null,
          messageId: null,
          rfcMessageId: "<orphan@example.test>",
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.isTrue(http.calls.some((call) => call.method === "GET"));
            assert.strictEqual(
              http.calls.filter((call) => call.method === "DELETE").length,
              exists ? 1 : 0,
            );
          }),
        ),
      );
    },
  );
}

for (const mode of ["reply", "forward"] as const) {
  for (const attempted of [false, true]) {
    it.live(
      `a single-save web ${mode} is never adopted after an uncertain create (${attempted ? "retry" : "lost response"})`,
      () => {
        const now = Date.now();
        const http = fakeHttp({
          [`POST /me/messages/source/${mode === "reply" ? "createReply" : "createForward"}`]: {
            status: 503,
          },
          "GET /me/messages/source": { json: { conversationId: "conversation" } },
          "GET /me/mailFolders/drafts/messages": (url) => ({
            json: {
              value: (url.searchParams.get("$filter") ?? "").startsWith("internetMessageId")
                ? []
                : [
                    {
                      id: "edited-web-draft",
                      conversationId: "conversation",
                      createdDateTime: new Date(now + 1000).toISOString(),
                      lastModifiedDateTime: new Date(now + 1000).toISOString(),
                      body: { contentType: "text", content: "Already written on another client" },
                      isDraft: true,
                    },
                  ],
            },
          }),
          "PATCH /me/messages/edited-web-draft": { json: { id: "edited-web-draft" } },
          "GET /me/messages/edited-web-draft/attachments": { json: { value: [] } },
        });
        return run(http, (adapter) =>
          Effect.gen(function* () {
            const result = yield* adapter
              .saveDraft(account, {
                creation: {
                  ...draftCreation(),
                  begin: () =>
                    Effect.succeed({
                      messageId: "<uncertain@example.test>",
                      attempted,
                      attemptedAt: now,
                    }),
                },
                remote: null,
                message: { ...draftMessage, mode, attachments: [] },
                original: Option.some({ providerId: "source", threadId: "conversation" }),
                replaceAttachments: false,
              })
              .pipe(Effect.result);
            assert.strictEqual(result._tag, "Failure");
            assert.isFalse(
              http.calls.some((call) => call.method === "PATCH" || call.method === "DELETE"),
            );
          }),
        );
      },
    );
  }
}

for (const stage of ["create", "patch"] as const) {
  it.effect(
    `reply recovery ignores a different Message-ID belonging to an in-flight ${stage}`,
    () =>
      Effect.gen(function* () {
        const patching = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let patches = 0;
        const http = fakeHttp({
          "POST /me/messages/source/createReply": { json: { id: "sending-template" } },
          "PATCH /me/messages/sending-template": { json: { id: "sending-template" } },
          "POST /me/messages/sending-template/send": { status: 202 },
          "GET /me/messages/source": { json: { conversationId: "conversation" } },
          "GET /me/mailFolders/drafts/messages": (url) => ({
            json: {
              value: (url.searchParams.get("$filter") ?? "").startsWith("internetMessageId")
                ? []
                : [
                    {
                      id: "sending-template",
                      conversationId: "conversation",
                      createdDateTime: new Date(0).toISOString(),
                      lastModifiedDateTime: new Date(0).toISOString(),
                      isDraft: true,
                    },
                  ],
            },
          }),
          "GET /me/messages/sending-template/attachments": { json: { value: [] } },
        });
        let held = false;
        const client = HttpClient.make((request) => {
          if (request.method === "PATCH") patches++;
          const hold =
            !held &&
            (stage === "create"
              ? request.url.endsWith("/createReply")
              : request.method === "PATCH");
          if (!hold) return http.client.execute(request);
          held = true;
          return http.client.execute(request).pipe(
            Effect.tap(() => Deferred.succeed(patching, undefined)),
            Effect.tap(() => Deferred.await(release)),
          );
        });
        yield* run({ ...http, layer: Layer.succeed(HttpClient.HttpClient, client) }, (adapter) =>
          Effect.gen(function* () {
            const message: OutgoingMessage = { ...draftMessage, mode: "reply", attachments: [] };
            const original = Option.some({ providerId: "source", threadId: "conversation" });
            const sending = yield* adapter.send(account, message, original).pipe(Effect.forkChild);
            yield* Deferred.await(patching);
            const recovered = yield* adapter
              .saveDraft(account, {
                creation: {
                  ...draftCreation(),
                  begin: () =>
                    Effect.succeed({
                      messageId: "<other@example.test>",
                      attempted: true,
                      attemptedAt: 0,
                    }),
                },
                remote: null,
                message,
                original,
                replaceAttachments: false,
              })
              .pipe(Effect.result);
            assert.strictEqual(recovered._tag, "Failure");
            yield* adapter.deleteDraft(account, {
              draftId: null,
              messageId: null,
              rfcMessageId: "<other@example.test>",
            });
            assert.isFalse(http.calls.some((call) => call.method === "DELETE"));
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(sending);
            assert.strictEqual(patches, 1);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
        );
      }),
  );
}

it.effect(
  "failed reply preparation never deletes an autosaved draft from the same conversation",
  () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const http = fakeHttp({
        "POST /me/messages/source/createReply": { status: 503 },
        "GET /me/messages/source": { json: { conversationId: "conversation" } },
        "GET /me/mailFolders/drafts/messages": (url) => ({
          json: {
            value: (url.searchParams.get("$filter") ?? "").startsWith("internetMessageId")
              ? []
              : [
                  {
                    id: "autosaved-R",
                    conversationId: "conversation",
                    createdDateTime: new Date(now).toISOString(),
                    lastModifiedDateTime: new Date(now).toISOString(),
                    isDraft: true,
                  },
                ],
          },
        }),
        "DELETE /me/messages/autosaved-R": { status: 204 },
      });
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          const sending = yield* adapter
            .send(
              account,
              { ...draftMessage, mode: "reply", attachments: [] },
              Option.some({ providerId: "source", threadId: "conversation" }),
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("35 seconds");
          const result = yield* Fiber.join(sending);
          assert.isTrue(result._tag === "Failure" && isDefiniteSendFailure(result.failure));
          assert.isFalse(http.calls.some((call) => call.method === "DELETE"));
          assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("/send")));
        }),
      );
    }),
);

it.effect("opening a server draft captures its server version before the first save", () => {
  let version = 1;
  const http = fakeHttp({
    "GET /me/messages/server-draft": (url) => ({
      json: url.searchParams.get("$select")?.includes("changeKey")
        ? {
            id: "server-draft",
            changeKey: `k${version}`,
            lastModifiedDateTime: new Date(version * 1000).toISOString(),
          }
        : { categories: [], flag: { flagStatus: "notFlagged" } },
    }),
    "POST /me/messages": {
      json: {
        id: "preserved-copy",
        changeKey: "copy",
        lastModifiedDateTime: new Date(3000).toISOString(),
      },
    },
    "PATCH /me/messages/server-draft": { json: { id: "overwritten" } },
  });
  const services = Layer.mergeAll(
    StoreLive,
    Layer.effect(Providers, makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter })))),
  ).pipe(Layer.provideMerge(Layer.mergeAll(http.layer, MemoryPlatform(platformOptions))));
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    const saved = yield* store.upsertAccount("outlook", account.email);
    yield* store.upsertMessage(saved.id, {
      providerId: "server-draft",
      threadId: "conversation",
      subject: "Server draft",
      from: { name: "", address: account.email },
      to: draftMessage.to,
      cc: [],
      date: 1000,
      snippet: "Draft",
      bodyText: "Draft",
      bodyHtml: "",
      labels: ["DRAFT"],
      attachments: [],
      isUnread: false,
      isStarred: false,
    });
    const opened = yield* mailbox.compose.openDraft(`${saved.id}/server-draft`);
    const before = Option.getOrThrow(yield* store.getDraft(opened.id));
    assert.strictEqual(before.remote?.changeKey, "k1");
    assert.strictEqual(before.remote?.lastWrittenAt, 1000);
    version = 2;
    yield* mailbox.compose.saveDraft({
      id: opened.id,
      accountId: saved.id,
      message: { ...opened.message, text: "Our edit" },
    });
    const after = Option.getOrThrow(yield* store.getDraft(opened.id));
    assert.strictEqual(after.remote?.messageId, "preserved-copy");
    assert.include(after.syncError ?? "", "another client");
    assert.isFalse(
      http.calls.some(
        (call) => call.method === "PATCH" && call.url.pathname.endsWith("/server-draft"),
      ),
    );
  }).pipe(
    Effect.provide(
      MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(Layer.provideMerge(services)),
    ),
  );
});

for (const mode of ["reply", "replyAll", "forward"] as const) {
  for (const scenario of ["kept", "ambiguous", "paginated"] as const) {
    it.effect(
      `${mode} recovery only adopts a unique complete exact Message-ID match: ${scenario}`,
      () => {
        let misses = 0;
        const candidate = {
          id: "our-copy",
          conversationId: "different-server-conversation",
          createdDateTime: new Date(-86400000).toISOString(),
          lastModifiedDateTime: new Date(86400000).toISOString(),
          isDraft: true,
        };
        const http = fakeHttp({
          "GET /me/mailFolders/drafts/messages": (url) => {
            const filter = url.searchParams.get("$filter") ?? "";
            assert.strictEqual(
              filter,
              "internetMessageId eq '<client@example.test>' and isDraft eq true",
            );
            return {
              json: {
                value:
                  scenario === "ambiguous"
                    ? [candidate, { ...candidate, id: "second-copy" }]
                    : [candidate],
                ...(scenario === "paginated"
                  ? { "@odata.nextLink": `${GRAPH}/me/mailFolders/drafts/messages?$skiptoken=more` }
                  : {}),
              },
            };
          },
          "PATCH /me/messages/our-copy": { json: { id: "our-copy" } },
          "GET /me/messages/our-copy/attachments": { json: { value: [] } },
        });
        return run(http, (adapter) =>
          Effect.gen(function* () {
            const result = yield* adapter
              .saveDraft(account, {
                creation: {
                  ...draftCreation(),
                  begin: () =>
                    Effect.succeed({
                      messageId: "<client@example.test>",
                      attempted: true,
                      attemptedAt: 365 * 86400000,
                    }),
                  missing: () =>
                    Effect.sync(() => {
                      misses++;
                      return false;
                    }),
                },
                remote: null,
                message: { ...draftMessage, attachments: [], mode },
                original: Option.some({ providerId: "source", threadId: "conversation" }),
                replaceAttachments: false,
              })
              .pipe(Effect.result);
            if (scenario === "kept") {
              assert.strictEqual(result._tag, "Success");
              if (result._tag === "Success")
                assert.strictEqual(result.success.messageId, "our-copy");
              assert.strictEqual(misses, 0);
              assert.strictEqual(http.calls.filter((call) => call.method === "PATCH").length, 1);
            } else {
              assert.strictEqual(result._tag, "Failure");
              assert.strictEqual(misses, 1);
              assert.isFalse(http.calls.some((call) => call.method !== "GET"));
            }
            assert.strictEqual(
              http.calls.filter((call) => call.url.pathname.endsWith("/drafts/messages")).length,
              1,
            );
          }),
        );
      },
    );
  }
}
