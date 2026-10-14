import { assert, it } from "@effect/vitest";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Option } from "effect";
import { account, run } from "../../../test-support/outlook-fixtures.js";

// E9-5: createReply and createForward answer 404 once the original is deleted or purged.
const gone = {
  status: 404,
  json: {
    error: {
      code: "ErrorItemNotFound",
      message: "The specified object was not found in the store.",
    },
  },
};
const message = {
  to: [{ name: "", address: "w@contoso.com" }],
  cc: [],
  bcc: [{ name: "", address: "hidden@contoso.com" }],
  subject: "Re: x",
  text: "ok",
  attachments: [],
};
const original = {
  providerId: "orig",
  threadId: "c",
  cached: { messageId: "<orig@contoso.com>", references: "<root@contoso.com>" },
};

it.effect("an Outlook reply to a deleted original goes out as MIME with the cached threading", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/orig/createReply": gone,
      "POST /me/sendMail": { status: 202 },
    });
    const result = yield* run(http, (a) =>
      a.send(account, { ...message, mode: "reply" }, Option.some(original)).pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Success");
    const sent = http.calls.find((call) => call.route === "POST /me/sendMail");
    assert.ok(sent, "no sendMail request");
    const raw = Buffer.from(String(sent.body), "base64").toString();
    assert.match(raw, /^In-Reply-To: <orig@contoso\.com>$/m);
    assert.match(raw, /^References: <root@contoso\.com> <orig@contoso\.com>$/m);
    // Graph reads To, CC and BCC from the MIME headers (user-post-messages, "Request body").
    assert.match(raw, /^Bcc: hidden@contoso\.com$/m);
  }),
);

it.effect(
  "an Outlook forward that keeps a deleted original's attachments fails before sending",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /me/messages/orig/createForward": gone,
        "POST /me/sendMail": { status: 202 },
      });
      const result = yield* run(http, (a) =>
        a
          .send(
            account,
            { ...message, subject: "Fw: x", mode: "forward" },
            Option.some({ ...original, hasAttachments: true }),
          )
          .pipe(Effect.result),
      );
      assert.isTrue(result._tag === "Failure" && result.failure._tag === "PermanentError");
      if (result._tag === "Failure")
        assert.match(result.failure.message, /attachments cannot be forwarded/);
      assert.isFalse(http.calls.some((call) => call.route === "POST /me/sendMail"));
    }),
);

it.effect("an Outlook forward of a deleted original without attachments still goes out", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/orig/createForward": gone,
      "POST /me/sendMail": { status: 202 },
    });
    const result = yield* run(http, (a) =>
      a
        .send(account, { ...message, subject: "Fw: x", mode: "forward" }, Option.some(original))
        .pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Success");
    assert.isTrue(http.calls.some((call) => call.route === "POST /me/sendMail"));
  }),
);
