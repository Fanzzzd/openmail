import { assert, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { logCodeOf } from "../domain/diagnostic-log.js";
import { NotFound } from "../domain/errors.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { fakeServer, incoming, outgoing } from "../platform/node/testing.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";

// "Sent, but archiving failed: <error message>" put the message in the log as it was, so an
// address in it reached every log sink, such as the console of the remote RPC server.
it.effect("a failed archive after a send logs its message without an address", () => {
  const lines: { code: unknown; text: string }[] = [];
  const logger = Logger.layer([
    Logger.make((options) => {
      lines.push({
        code: logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations)),
        text: JSON.stringify(options.message),
      });
    }),
  ]);
  const server = fakeServer("me@gmail.com", [incoming("m1", { labels: ["INBOX"] })]);
  const platform = MemoryPlatform();
  // Once the provider has the reply, the archive that follows fails to read its thread.
  const store = Layer.effect(
    Store,
    Effect.map(Store, (live) => ({
      ...live,
      messageRef: (id: string) =>
        server.sent.length > 0
          ? Effect.fail(
              Object.assign(new NotFound({ what: "message", id }), {
                message: `No message ${id} for alex@example.com`,
              }),
            )
          : live.messageRef(id),
    })),
  ).pipe(Layer.provide(StoreLive.pipe(Layer.provideMerge(platform))));
  const providers = Layer.succeed(Providers, { get: () => makeFakeProvider(server) });
  const mailbox = MailboxLive({ backgroundFlush: false }).pipe(
    Layer.provide(Layer.mergeAll(store, platform, providers)),
  );
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.accounts.connect({ provider: "gmail" });
    yield* m.sync.sync();
    const [thread] = yield* m.reading.threads({ mailbox: "inbox" });
    const outcome = yield* m.organize.perform(
      {
        kind: "send",
        accountId: "gmail:me@gmail.com",
        message: outgoing({ mode: "reply", inReplyTo: thread!.id, subject: "Re: 主题 m1" }),
        archive: true,
      },
      { kind: "user", surface: "app" },
    );
    assert.strictEqual(outcome.status, "applied");
    assert.strictEqual(server.sent.length, 1);
    const warning = lines.find((line) => line.code === "sent-archive-failed");
    assert.include(warning?.text, "Sent, but archiving failed: No message");
    assert.include(warning?.text, "<address>");
    for (const line of lines) assert.notInclude(line.text, "alex@example.com");
  }).pipe(Effect.provide(Layer.merge(mailbox, logger)));
});
