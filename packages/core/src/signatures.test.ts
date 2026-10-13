import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseLayer } from "./platform/node/db.js";
import { DEFAULT_PREFS } from "./domain/domain.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox/mailbox.js";
import { MailboxLive } from "./mailbox/mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store/store.js";
import { orderedSignatures } from "./signatures.js";
import { applySignature } from "./compose-text.js";
import { applyComposeSignature, remoteComposeBody, richComposeBody } from "./compose-body.js";
{
  const temporary = Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "om-fixture-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

  const sessions =
    (file: string, server: ReturnType<typeof fakeServer>, strictFolders = false) =>
    () =>
      MailboxLive({ backgroundFlush: false }).pipe(
        Layer.provideMerge(
          Layer.merge(
            StoreLive.pipe(Layer.provide(databaseLayer(file).pipe(Layer.provide(NodeSystem)))),
            Layer.succeed(Providers, { get: () => makeFakeProvider(server, { strictFolders }) }),
          ),
        ),
        Layer.provide(MemoryPlatform()),
      );

  it.effect("signature formatting, order and preferences persist in a temporary database", () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const session = sessions(join(directory, "mail.db"), fakeServer("me@example.com"));
      const ids = yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        const a = yield* m.saveNamedSignature({
          address: "me@example.com",
          name: "A",
          text: "Ignored",
          html: '<b>A</b><span style="color:#ff0000">Red</span><script>PRIVATE_SCRIPT</script><img src="https://tracker.invalid"><a href="javascript:bad()">link</a>',
        });
        const b = yield* m.saveNamedSignature({ address: "me@example.com", name: "B", text: "B" });
        assert.ok(a.html?.includes("<strong>A</strong>"));
        assert.ok(!/PRIVATE_SCRIPT|tracker|javascript/.test(a.html ?? ""));
        yield* m.setPrefs({
          signatureOrder: [b.id, a.id],
          signaturePosition: "below",
          signatureSeparator: false,
        });
        return [b.id, a.id];
      }).pipe(Effect.provide(session()));
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        const prefs = yield* m.prefs;
        assert.strictEqual(prefs.signaturePosition, "below");
        assert.strictEqual(prefs.signatureSeparator, false);
        assert.deepStrictEqual(
          orderedSignatures(yield* m.namedSignatures, prefs.signatureOrder).map(
            (signature) => signature.id,
          ),
          ids,
        );
      }).pipe(Effect.provide(session()));
    }).pipe(Effect.scoped),
  );

  it("signatures respect quote position and separator in plain, Markdown and sanitized rich bodies", () => {
    const signature = { text: "Me", html: "<strong>Me</strong>" };
    const text = "Answer\n\nOn Monday wrote:\n> Quoted";
    for (const signaturePosition of ["above", "below"] as const)
      for (const signatureSeparator of [true, false]) {
        const options = { signaturePosition, signatureSeparator };
        const plain = applySignature(text, undefined, "Me", options);
        assert.strictEqual(plain.includes("-- \n"), signatureSeparator);
        assert.strictEqual(
          plain.indexOf("Me") < plain.indexOf("On Monday"),
          signaturePosition === "above",
        );
        assert.strictEqual(applySignature(plain, "Me", "You", options).split("You").length, 2);
        const markdown = applyComposeSignature(
          { kind: "markdown", text },
          undefined,
          signature,
          options,
        );
        assert.strictEqual(markdown.text, plain);
        const rich = applyComposeSignature(
          richComposeBody("<p>Answer</p><blockquote>Quoted</blockquote>"),
          undefined,
          signature,
          options,
        );
        assert.ok(rich.kind === "rich");
        assert.strictEqual(
          rich.html.indexOf("<strong>Me</strong>") < rich.html.indexOf("<blockquote>"),
          signaturePosition === "above",
        );
        assert.strictEqual(rich.text.split("\n").includes("--"), signatureSeparator);
        const replaced = applyComposeSignature(
          rich,
          signature,
          { text: "You", html: "<em>You</em>" },
          options,
        );
        assert.ok(replaced.kind === "rich");
        assert.ok(replaced.html.includes("<em>You</em>"));
        assert.ok(!replaced.html.includes("<strong>Me</strong>"));
      }
    const remote = remoteComposeBody(
      '<blockquote>Quoted<img src="https://remote.invalid"></blockquote>',
    );
    const below = { ...DEFAULT_PREFS, signaturePosition: "below" } as const;
    const signed = applyComposeSignature(remote, undefined, signature, below);
    const replaced = applyComposeSignature(
      signed,
      signature,
      { text: "You", html: "<em>You</em>" },
      below,
    );
    assert.ok(replaced.kind === "rich");
    assert.ok(!replaced.originalHtml?.includes("https://remote.invalid"));
    assert.ok(replaced.originalHtml?.includes("<blockquote>Quoted</blockquote>"));
    assert.ok(replaced.originalHtml?.endsWith("<div>--<br><em>You</em></div>"));
  });

  it("changing the quote preference moves an unchanged signature to the new position", () => {
    const signature = { text: "Me", html: "<strong>Me</strong>" };
    const above = applyComposeSignature(
      richComposeBody("<div>Answer</div><blockquote>Quote</blockquote>"),
      undefined,
      signature,
    );
    const below = applyComposeSignature(above, signature, signature, {
      signaturePosition: "below",
      signatureSeparator: false,
    });
    assert.ok(below.kind === "rich");
    assert.ok(below.html.indexOf("Me") > below.html.indexOf("</blockquote>"));
    assert.ok(!below.text.split("\n").includes("--"));
    const again = applyComposeSignature(below, signature, signature);
    assert.ok(again.kind === "rich");
    assert.ok(again.html.indexOf("Me") < again.html.indexOf("<blockquote>"));
    assert.strictEqual(again.html.split("Me").length, 2);
  });

  it("forwarded signatures are never replaced or used to suppress a below-quote signature", () => {
    const body = "Forwarding\n\n---------- Forwarded message ----------\nBody\n-- \nAlice Work";
    const options = { signaturePosition: "below", signatureSeparator: true } as const;
    const inserted = applySignature(body, undefined, "Me", options);
    assert.strictEqual(inserted, `${body}\n\n-- \nMe`);
    const same = applySignature(body, "Alice Work", "Me", options);
    assert.strictEqual(same, `${body}\n\n-- \nMe`);
    const two = `${body}\n\n-- \nAlice Work`;
    assert.strictEqual(applySignature(two, "Alice Work", "Me", options), `${body}\n\n-- \nMe`);
  });
}
