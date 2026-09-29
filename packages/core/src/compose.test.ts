import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { buildMime } from "./compose.js";
import type { OutgoingMessage } from "./domain.js";

const message: OutgoingMessage = {
  to: [{ name: "王工", address: "wang@contoso.com" }],
  cc: [{ name: "", address: "cc@x.com" }],
  bcc: [{ name: "", address: "hidden@x.com" }],
  subject: "报价确认",
  text: "收到",
  attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" }],
};

const threading = { messageId: "<orig@x.com>", references: "<root@x.com>" };
const from = { name: "", address: "me@gmail.com" };

const build = (m: OutgoingMessage) =>
  Effect.map(buildMime(from, m, threading), (b) => b.toString());

describe("buildMime", () => {
  it.effect("replies carry In-Reply-To and the extended References", () =>
    Effect.gen(function* () {
      const raw = yield* build({ ...message, mode: "replyAll" });
      assert.match(raw, /^In-Reply-To: <orig@x\.com>/m);
      assert.match(raw, /^References: <root@x\.com> <orig@x\.com>/m);
    }),
  );

  it.effect("forwards and new messages start a thread of their own", () =>
    Effect.gen(function* () {
      for (const mode of ["forward", "new"] as const) {
        const raw = yield* build({ ...message, mode });
        assert.notMatch(raw, /^In-Reply-To:/m);
        assert.notMatch(raw, /^References:/m);
      }
    }),
  );

  it.effect("keeps Bcc, encodes UTF-8 headers and attaches files", () =>
    Effect.gen(function* () {
      const raw = yield* build(message);
      assert.match(raw, /^Bcc: hidden@x\.com/m);
      assert.match(raw, /^Subject: =\?UTF-8\?/m);
      assert.match(raw, /filename=a\.txt/);
      assert.match(raw, /^aGk=/m);
    }),
  );
});
