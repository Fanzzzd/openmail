import { OPTIONAL_SCOPES } from "../../../../packages/core/src/providers/optional-services.js";
import { Effect, Layer, Queue } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { RpcClient, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { expect, it } from "vitest";
import { MailboxLive } from "../../../../packages/core/src/mailbox/mailbox-live.js";
import { Mailbox } from "../../../../packages/core/src/mailbox/mailbox.js";
import { makeOutlook } from "../../../../packages/core/src/providers/outlook/outlook.js";
import { makeGmail } from "../../../../packages/core/src/providers/gmail/gmail.js";
import { Store, StoreLive } from "@openmail/core/testing/node";
import { Providers } from "../../../../packages/core/src/providers/adapter.js";
import { MemoryPlatform } from "../../../../packages/core/src/platform/node/platform-memory.js";
import { mailboxHandlers } from "./mailbox-handlers";
import { MailRpcs } from "./rpc";
import { publicRpcResponse, createRpcFailureTracker } from "../main/rpc/rpc-security";

for (const denied of [
  "outlook-contacts",
  "outlook-people",
  "gmail-contacts",
  "outlook-auth",
] as const) {
  it(`${denied} RefreshContacts RPC separates disabled permissions from fresh-token failures`, async () => {
    const provider = denied === "gmail-contacts" ? "gmail" : "outlook";
    const accountId = `${provider}:fake@example.com`;
    const calls: string[] = [];
    const http = HttpClient.make((request, url) =>
      Effect.sync(() => {
        calls.push(url.pathname);
        const blocked = denied === "outlook-people" ? url.pathname === "/v1.0/me/people" : true;
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(blocked ? { error: "Access denied" } : { value: [] }), {
            status: blocked ? (denied === "outlook-auth" ? 401 : 403) : 200,
          }),
        );
      }),
    );
    const adapters = Layer.effect(
      Providers,
      Effect.gen(function* () {
        const adapter = yield* provider === "outlook" ? makeOutlook : makeGmail;
        return Providers.of({ get: () => adapter });
      }),
    );
    const platform = MemoryPlatform({
      secrets: { [accountId]: "fake-refresh" },
      config: {
        microsoft: { clientId: "fake-client" },
        google: { clientId: "fake-client", clientSecret: "fake-secret" },
      },
    });
    const layer = MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(StoreLive, adapters).pipe(
          Layer.provideMerge(Layer.mergeAll(platform, Layer.succeed(HttpClient.HttpClient, http))),
        ),
      ),
    );
    const rpc = MailRpcs.requests.get("RefreshContacts");
    if (rpc?._tag !== "RefreshContacts") throw new Error("Missing RefreshContacts RPC");
    const group = RpcGroup.make(rpc);
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        yield* store.upsertAccount(provider, "fake@example.com");
        yield* store.setGrantedScopes(accountId, OPTIONAL_SCOPES[provider].contacts);
        const requests = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
        const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
        const disconnects = yield* Queue.unbounded<number>();
        const authTags: string[] = [];
        const failures = createRpcFailureTracker((tag) => authTags.push(tag));
        const protocol = Layer.succeed(RpcServer.Protocol, {
          run: (write) =>
            Queue.take(requests).pipe(
              Effect.flatMap((request) => {
                failures.request(0, [request]);
                return write(0, request);
              }),
              Effect.forever,
            ),
          send: (_id, response) => {
            failures.response(0, response);
            return Queue.offer(responses, publicRpcResponse(response)).pipe(Effect.asVoid);
          },
          end: () => Effect.void,
          disconnects,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: false,
          codecFor: RpcSerialization.json.codecFor,
        });
        const clientProtocol = Layer.succeed(RpcClient.Protocol, {
          run: (_id, write) => Queue.take(responses).pipe(Effect.flatMap(write), Effect.forever),
          send: (_id, request) => Queue.offer(requests, request).pipe(Effect.asVoid),
          supportsAck: false,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor,
        });
        yield* RpcServer.make(group).pipe(
          Effect.provide(protocol),
          Effect.provide(
            group.toLayer({ RefreshContacts: mailboxHandlers(mailbox).RefreshContacts }),
          ),
          Effect.forkScoped,
        );
        const client = yield* RpcClient.make(group).pipe(Effect.provide(clientProtocol));
        const result = yield* client.RefreshContacts({ accountId }).pipe(Effect.result);
        if (denied === "outlook-auth") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("AuthError");
          expect(authTags).toEqual(["RefreshContacts"]);
          expect((yield* mailbox.calendar.contactSync)[0]?.scopeMissing).toBe(false);
          return;
        }
        expect(authTags).toEqual([]);
        expect(result._tag).toBe("Success");
        expect((yield* mailbox.calendar.contactSync)[0]?.scopeMissing).toBe(true);
        const attempts = calls.length;
        yield* client.RefreshContacts({ accountId });
        expect(calls.length).toBe(attempts);
        expect((yield* mailbox.accounts.accounts)[0]?.needsReauth).toBe(false);
        expect(yield* mailbox.compose.suggestContacts("fake")).toEqual([]);
        expect(yield* mailbox.calendar.contactPhoto(accountId, "fake@example.com")).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
}
