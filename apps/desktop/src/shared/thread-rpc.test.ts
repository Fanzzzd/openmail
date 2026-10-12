import { Effect, Layer, Queue } from "effect";
import { SqlClient } from "effect/sql";
import { RpcClient, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { expect, it } from "vitest";
import { Mailbox } from "../../../../packages/core/src/mailbox.js";
import { MailboxLive } from "../../../../packages/core/src/mailbox-live.js";
import { ProviderError } from "../../../../packages/core/src/errors.js";
import { Providers } from "../../../../packages/core/src/services.js";
import { Store, StoreLive } from "@openmail/core/testing/node";
import { MemoryPlatform } from "../../../../packages/core/src/platform/node/platform-memory.js";
import {
  fakeServer,
  makeFakeProvider,
} from "../../../../packages/core/src/platform/node/fake-provider.js";
import { mailboxHandlers } from "./mailbox-handlers";
import { MailRpcs } from "./rpc";
import { publicRpcResponse } from "../main/rpc/rpc-security";

it("Thread RPC returns legacy cached text when fetchMessage fails with status zero", async () => {
  const base = makeFakeProvider(fakeServer("cached@example.com"));
  const adapter = {
    ...base,
    fetchMessage: () => Effect.fail(new ProviderError({ message: "offline", status: 0 })),
  };
  const dependencies = Layer.mergeAll(
    StoreLive,
    Layer.succeed(Providers, { get: () => adapter }),
  ).pipe(Layer.provideMerge(MemoryPlatform()));
  const rpc = MailRpcs.requests.get("Thread");
  if (rpc?._tag !== "Thread") throw new Error("Missing Thread RPC");
  const group = RpcGroup.make(rpc);
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("outlook", "cached@example.com");
      const id = `${account.id}/legacy`;
      yield* store.upsertMessage(account.id, {
        providerId: "legacy",
        threadId: "thread",
        subject: "Cached",
        from: { name: "Sender", address: "sender@example.com" },
        to: [],
        cc: [],
        date: 1,
        snippet: "Cached preview",
        bodyText: "Cached text",
        bodyHtml: "",
        labels: ["INBOX"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      });
      yield* sql`UPDATE messages SET reply_to_json=NULL WHERE id=${id}`;
      const requests = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
      const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const disconnects = yield* Queue.unbounded<number>();
      const protocol = Layer.succeed(RpcServer.Protocol, {
        run: (write) =>
          Queue.take(requests).pipe(
            Effect.flatMap((request) => write(0, request)),
            Effect.forever,
          ),
        send: (_id, response) =>
          Queue.offer(responses, publicRpcResponse(response)).pipe(Effect.asVoid),
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
        Effect.provide(group.toLayer({ Thread: mailboxHandlers(mailbox).Thread })),
        Effect.forkScoped,
      );
      const client = yield* RpcClient.make(group).pipe(Effect.provide(clientProtocol));
      const messages = yield* client.Thread({ id });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id,
        bodyText: "Cached text",
        snippet: "Cached preview",
        bodyRefresh: "failed",
      });
      expect(messages[0]?.replyTo).toBeUndefined();
      expect((yield* mailbox.accounts)[0]?.needsReauth).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(Layer.provideMerge(dependencies)),
      ),
    ),
  );
});
