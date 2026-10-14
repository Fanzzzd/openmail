import { expect, it } from "vitest";
import { sendOriginal } from "./send-original.js";

it("carries the cached Message-ID and References of the original", () => {
  expect(
    sendOriginal("p1", {
      threadId: "t1",
      rfcMessageId: "orig@x.com",
      headers: [{ name: "References", value: " <root@x.com> " }],
      attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 1 }],
    }),
  ).toEqual({
    providerId: "p1",
    threadId: "t1",
    cached: { messageId: "<orig@x.com>", references: "<root@x.com>" },
    hasAttachments: true,
  });
});

it("leaves the cache out when it has no Message-ID", () => {
  expect(sendOriginal("p1", { threadId: "t1", attachments: [] })).toEqual({
    providerId: "p1",
    threadId: "t1",
  });
});
