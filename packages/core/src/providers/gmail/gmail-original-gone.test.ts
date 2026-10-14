import { fakeHttp } from "../../platform/node/fake-http.js";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { account, run, outgoing } from "../../../test-support/gmail-fixtures.js";

const Sent = Schema.Struct({ raw: Schema.String, threadId: Schema.optionalKey(Schema.String) });

// E9-5: Gmail answers 404 for the original once it is purged from Trash.
it.effect(
  "a reply to an original Gmail already purged goes out on the cached threading headers",
  () => {
    const http = fakeHttp({
      "GET /messages/source": {
        status: 404,
        json: { error: { code: 404, message: "Requested entity was not found." } },
      },
      "POST /messages/send": { json: { id: "sent", threadId: "new-thread" } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .send(
            account,
            { ...outgoing, mode: "reply" },
            Option.some({
              providerId: "source",
              threadId: "conversation",
              cached: { messageId: "<orig@x.com>", references: "<root@x.com>" },
            }),
          )
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Success");
        const post = http.calls.find((call) => call.method === "POST");
        assert.ok(post, "no send request was made");
        const body = Schema.decodeUnknownSync(Sent)(post.body);
        // The original thread is gone, so the message starts a new Gmail thread.
        assert.isUndefined(body.threadId);
        const raw = Buffer.from(body.raw, "base64url").toString();
        assert.match(raw, /^In-Reply-To: <orig@x\.com>$/m);
        assert.match(raw, /^References: <root@x\.com> <orig@x\.com>$/m);
      }),
    );
  },
);
