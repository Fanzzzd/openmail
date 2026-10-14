import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { databaseLayer } from "../platform/node/db.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { makeFakeProvider, fakeServer } from "../platform/node/fake-provider.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { StoreLive } from "../store/store.js";
import { Providers } from "../providers/adapter.js";
import { richComposeBody, composeHtmlHasUnsupported } from "./compose-body.js";
import { composeTransportHtml } from "./compose-transport.js";
import { buildMime } from "../platform/node/compose.js";
import type { Provider } from "../domain/account.js";

const source =
  '<div dir="auto" style="text-align:right;margin-left:24px"><span style="font-family:Georgia;font-size:18px;color:#123;background-color:#fff">שלום <sup>2</sup><sub>3</sub><s>old</s><code>x</code></span></div><blockquote><blockquote>nested</blockquote></blockquote><ul type="dash"><li>dash</li></ul><ol type="1"><li>number</li></ol><pre> a  b\nc</pre>';
for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: formatting and toggles survive draft push, database reopen and MIME send`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "om-format-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer("me@example.com");
        const adapter = makeFakeProvider(server);
        const layer = () =>
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provide(
              Layer.merge(
                StoreLive.pipe(
                  Layer.provide(
                    databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
                  ),
                ),
                Layer.succeed(Providers, { get: () => adapter }),
              ),
            ),
            Layer.provide(MemoryPlatform()),
          );
        const body = richComposeBody(source);
        const id = yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    password: "fake",
                    imapHost: "imap.example.com",
                    imapPort: 993,
                    smtpHost: "smtp.example.com",
                    smtpPort: 465,
                    smtpSecure: true,
                  },
                }
              : { provider },
          );
          const prefs = yield* mailbox.app.prefs;
          assert.strictEqual(prefs.composeFormatBar, true);
          assert.strictEqual(prefs.composeSmartLists, true);
          yield* mailbox.app.setPrefs({
            composeFormatBar: false,
            composeSmartLists: false,
            composeMarkdownReplacement: false,
          });
          const saved = yield* mailbox.compose.saveDraft({
            id: "draft:format",
            accountId: `${provider}:${server.email}`,
            message: {
              to: [{ name: "", address: "you@example.com" }],
              cc: [],
              bcc: [],
              subject: "Formatted",
              text: "stale",
              html: source,
              attachments: [],
            },
          });
          assert.strictEqual(saved.message.html, body.html);
          assert.strictEqual(saved.message.text, body.text);
          assert.strictEqual(server.draftLog.at(-1)?.kind, "save");
          return saved.id;
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const prefs = yield* mailbox.app.prefs;
          assert.strictEqual(prefs.composeFormatBar, false);
          assert.strictEqual(prefs.composeSmartLists, false);
          assert.strictEqual(prefs.composeMarkdownReplacement, false);
          const draft = yield* mailbox.compose.openDraft(id);
          assert.strictEqual(draft.message.html, body.html);
          assert.strictEqual(composeHtmlHasUnsupported(draft.message.html ?? ""), false);
          yield* mailbox.perform(
            { kind: "send", accountId: draft.accountId, draftId: id, message: draft.message },
            { kind: "user", surface: "app" },
          );
          const sent = server.sent.at(-1);
          assert.ok(sent);
          assert.strictEqual(sent.message.text, body.text);
          const mime = yield* buildMime({ name: "", address: server.email }, sent.message);
          const parsed = yield* Effect.promise(() => simpleParser(mime));
          assert.include(
            parsed.html || "",
            "font-family:Georgia;font-size:18px;color:#123;background-color:#fff",
          );
          assert.include(parsed.html || "", " <sup>2</sup><sub>3</sub><s>old</s><code>x</code>");
          assert.include(
            parsed.html || "",
            'style="border-left:2px solid #ccc;padding-left:12px;margin-left:0"',
          );
          assert.include(
            parsed.html || "",
            '<ul type="dash" style="list-style-type:none"><li>– dash</li></ul>',
          );
          assert.strictEqual(composeHtmlHasUnsupported(parsed.html || ""), false);
          assert.deepStrictEqual(richComposeBody(parsed.html || ""), body);
          assert.strictEqual(
            composeTransportHtml({ html: richComposeBody(parsed.html || "").html }),
            composeTransportHtml({ html: body.html }),
          );
          assert.include(parsed.text ?? "", "> > nested");
          assert.include(parsed.text ?? "", " a  b\nc");
        }).pipe(Effect.provide(layer()));
      }),
  );
}
