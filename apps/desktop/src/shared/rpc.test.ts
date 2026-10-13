import { Effect, Layer, Queue, Schema, Struct } from "effect";
import { RpcClient, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { expect, it } from "vitest";
import {
  DEFAULT_ACTIVE_HOURS,
  DEFAULT_PREFS,
  Prefs,
  PrefsPatch,
  Proposal,
} from "@openmail/core/schema";
import { Mailbox } from "../../../../packages/core/src/mailbox/mailbox.js";
import { TestMailbox } from "../../../../packages/core/src/platform/node/testing.js";
import { MailRpcs } from "./rpc";

it("every Prefs field survives the real RPC client/server JSON codecs and is stored", async () => {
  const set = MailRpcs.requests.get("SetPrefs");
  const get = MailRpcs.requests.get("Prefs");
  if (set?._tag !== "SetPrefs" || get?._tag !== "Prefs") throw new Error("Missing preference RPCs");
  const group = RpcGroup.make(set, get);
  const values: Prefs = {
    ...DEFAULT_PREFS,
    useAppleContacts: true,
    messageListDensity: "expanded",
    specialFolderBadges: { starred: false, drafts: true, spam: false },
    showAccountLabels: true,
    notificationActions: ["menu", "read"],
    menuBarUnreadCount: true,
    activeHours: { work: { ...DEFAULT_ACTIVE_HOURS, enabled: true } },
  };
  const received: Partial<Prefs>[] = [];
  const handlers = group.toLayer(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      return {
        SetPrefs: ({ patch }) =>
          Effect.sync(() => {
            received.push(patch);
          }).pipe(Effect.andThen(mailbox.setPrefs(patch))),
        Prefs: () => mailbox.prefs,
      };
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      // Encoded transport only: unlike RpcTest, make() invokes both real schema codecs.
      const requests = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
      const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const disconnects = yield* Queue.unbounded<number>();
      const serverProtocol = Layer.succeed(RpcServer.Protocol, {
        run: (write) =>
          Queue.take(requests).pipe(
            Effect.flatMap((request) => write(0, request)),
            Effect.forever,
          ),
        send: (_id, response) => Queue.offer(responses, response).pipe(Effect.asVoid),
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
        Effect.provide(serverProtocol),
        Effect.provide(handlers),
        Effect.forkScoped,
      );
      const client = yield* RpcClient.make(group).pipe(Effect.provide(clientProtocol));
      // remoteImagesChosen is read only; storing any mode sets it.
      for (const key of Struct.keys(PrefsPatch.fields)) {
        const patch = { [key]: values[key] };
        yield* client.SetPrefs({ patch });
        expect(received.at(-1)).toEqual(patch);
        expect((yield* client.Prefs())[key]).toEqual(values[key]);
      }
      yield* client.SetPrefs({ patch: {} });
      expect(received.at(-1)).toEqual({});
      expect(yield* client.Prefs()).toEqual({ ...values, remoteImagesChosen: true });
      // The patch schema drops the derived flag, so the renderer cannot hide the prompt.
      const forged: Partial<Prefs> = { remoteImagesChosen: false };
      yield* client.SetPrefs({ patch: forged });
      expect(received.at(-1)).toEqual({});
    }).pipe(Effect.scoped, Effect.provide(TestMailbox())),
  );
});

it("Proposal schemas expose only proposal fields, without account metadata", () => {
  expect(Object.keys(Proposal.fields)).toEqual(["id", "createdAt", "actor", "command", "status"]);
  const proposals = MailRpcs.requests.get("Proposals");
  if (proposals?._tag !== "Proposals") throw new Error("Missing proposal RPC");
  const proposal = {
    id: 1,
    createdAt: 0,
    actor: { kind: "user", surface: "app" },
    command: { kind: "removeAccount", accountId: "gmail:me@example.com" },
    status: "pending",
  } as const;
  const polluted = {
    ...proposal,
    enabled: false,
    description: "Account",
    color: "#123456",
    position: 5,
  };
  const encoded = Schema.encodeSync(proposals.successSchema)([polluted]);
  expect(Schema.decodeUnknownSync(proposals.successSchema)(encoded)).toEqual([proposal]);
});

it("manual Sync and network RPCs clear backoff before pulling", async () => {
  const { mailboxHandlers } = await import("./mailbox-handlers");
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const calls: string[] = [];
      const handlers = mailboxHandlers({
        ...mailbox,
        resetConnectivity: () =>
          Effect.sync(() => {
            calls.push("reset");
          }),
        sync: () =>
          Effect.sync(() => {
            calls.push("sync");
            return [];
          }),
      });
      yield* handlers.Sync();
      yield* handlers.NetworkChanged();
      expect(calls).toEqual(["reset", "sync", "reset", "sync"]);
    }).pipe(Effect.provide(TestMailbox())),
  );
});
