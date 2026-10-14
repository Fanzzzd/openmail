import { createHash, createHmac } from "node:crypto";
import { isIP as nodeIsIP } from "node:net";
import { Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { expect, it } from "vitest";
import {
  Mailbox,
  MailboxLive,
  PortableMailbox,
  MobileBackgroundStorage,
  MobileBackgroundStorageLive,
  DEFAULT_MOBILE_BACKGROUND,
  MailTransport,
  MailCodec,
  type MailCodecPort,
  PlatformCrypto,
  Providers,
  sha256Hex,
  hmacSha256Hex,
} from "../portable.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { isIP } from "./ip.js";
import { MemoryPlatform } from "./node/platform-memory.js";
import { fakeServer, makeFakeProvider } from "./node/fake-provider.js";

it("platform fingerprints preserve the native UTF-8 SHA-256 and HMAC results", () => {
  for (const input of ["", "abc", "消息文本\r\nCafé 📨", "unpaired\ud800", "x".repeat(100_000)]) {
    expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
    expect(hmacSha256Hex("key", input)).toBe(
      createHmac("sha256", "key").update(input).digest("hex"),
    );
  }
});
it("portable IP parsing preserves Node's literal classification for pinned image requests", () => {
  for (const input of [
    "",
    "localhost",
    "127.0.0.1",
    "01.2.3.4",
    "256.1.1.1",
    "8.8.8.8",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2606:4700:4700::1111",
    "1:2:3:4:5:6:7:8",
    "1::2::3",
    "1:2:3:4:5:6:7:8:9",
    "2606:4700::1%",
    "2606:4700::1%eth0",
    "2606:4700::1%foo-1",
    "2606:4700::1%foo/bar",
    "2606:4700::1%eth_0",
    "2606:4700::1%a:b",
    "2606:4700::1%foo%bar",
  ])
    expect(isIP(input)).toBe(nodeIsIP(input));
});
it("a mailbox keeps its own MIME and random services after the platform Layer is built", async () => {
  const server = fakeServer("me@example.com", [
    {
      providerId: "sent",
      threadId: "sent",
      subject: "Sent",
      from: { name: "Me", address: "me@example.com" },
      to: [],
      cc: [],
      date: 1,
      snippet: "",
      bodyText: "",
      bodyHtml: "",
      attachments: [],
      labels: ["SENT"],
      isUnread: false,
      isStarred: false,
    },
  ]);
  server.raw.set("sent", new Uint8Array([1]));
  let parses = 0;
  const codec: MailCodecPort = {
    parse: () => {
      parses++;
      return Promise.resolve({
        html: false,
        headers: new Map(),
        attachments: [],
        subject: "Platform source",
        text: "Decoded on mobile",
      });
    },
    build: () => Effect.die(new Error("This test's fake provider does not build MIME")),
  };
  const uuid = "00000000-0000-4000-8000-000000000039";
  const platform = Layer.mergeAll(
    MemoryPlatform(),
    Layer.succeed(MailCodec, codec),
    Layer.succeed(PlatformCrypto, {
      randomUUID: () => uuid,
      sha256: sha256Hex,
      hmac: hmacSha256Hex,
    }),
  );
  let createdMessageId: string | undefined;
  const provider = {
    ...makeFakeProvider(server),
    saveDraft: (_account: unknown, push: import("../providers/adapter.js").DraftPush) =>
      Effect.gen(function* () {
        const state = yield* push.creation.begin();
        createdMessageId = state.messageId;
        return { draftId: "remote-draft", messageId: "remote-draft" };
      }),
  };
  const layer = MailboxLive({ backgroundFlush: false }).pipe(
    Layer.provide(
      Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => provider })).pipe(
        Layer.provideMerge(platform),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const mailbox = Context.get(context, Mailbox);
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const draft = yield* mailbox.outbox.sendAgain(`${account.id}/sent`);
      expect(draft.id).toBe(`draft:${uuid}`);
      expect(draft.message.text).toBe("Decoded on mobile");
      expect(parses).toBe(1);
      const image = yield* mailbox.compose.imageFromFile({
        filename: "image.png",
        content: "iVBORw0KGgo=",
        mimeType: "image/png",
      });
      expect(image.contentId).toBe(`image-${uuid}@openmail`);
      yield* mailbox.compose.saveDraft({
        id: draft.id,
        accountId: account.id,
        message: { ...draft.message, subject: "Edited" },
      });
      expect(createdMessageId).toBe(`<${uuid}@example.com>`);
    }).pipe(Effect.scoped),
  );
});

it("portable assembly exposes Mailbox alongside background storage and hides internal services", async () => {
  const layer = Layer.mergeAll(
    PortableMailbox({ imapIdle: false, backgroundFlush: false, localDraftQueue: true }),
    MobileBackgroundStorageLive,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        MemoryPlatform(),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die(new Error("Unexpected HTTP request"))),
        ),
        Layer.succeed(MailTransport, {
          connect: async () => {
            throw new Error("Unexpected mail transport");
          },
        }),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      expect(Context.getOption(context, Store)._tag).toBe("None");
      expect(Context.getOption(context, Providers)._tag).toBe("None");
      const mailbox = Context.get(context, Mailbox);
      const background = Context.get(context, MobileBackgroundStorage);
      expect(yield* mailbox.accounts).toEqual([]);
      expect(yield* background.preferences).toEqual(DEFAULT_MOBILE_BACKGROUND);
      yield* mailbox.app.setPrefs({ markReadDelay: "manual" });
      yield* background.save({ ...DEFAULT_MOBILE_BACKGROUND, badge: true });
      expect((yield* mailbox.app.prefs).markReadDelay).toBe("manual");
      expect((yield* background.preferences).badge).toBe(true);
    }).pipe(Effect.scoped),
  );
});
