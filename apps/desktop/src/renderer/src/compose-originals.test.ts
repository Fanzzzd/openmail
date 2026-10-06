import { Effect, Cause } from "effect";
import { expect, it } from "vitest";
import { emptyDraft, type Draft } from "./draft";
import {
  inheritsOriginals,
  withOriginalAttachments,
  loadOriginalAttachments,
} from "./compose-originals";
import { richComposeBody } from "@openmail/core/schema";

it.each([
  ["logo%40example.com", "logo@example.com"],
  ["logo@example.com", "logo%40example.com"],
])("encoded forward CID %s matches attachment %s", (reference, contentId) => {
  const draft = {
    ...emptyDraft("outlook:me"),
    mode: "forward",
    inReplyTo: "original",
    body: richComposeBody(`<img src="cid:${reference}">`),
  } satisfies Draft;
  const loaded = withOriginalAttachments(draft, [
    {
      filename: "logo.png",
      mimeType: "image/png",
      content: "aGk=",
      contentId,
      sourceMessageId: "original",
    },
  ]);
  expect(loaded.attachments[0]?.contentId).toBe("logo@example.com");
});

it("a failed background load leaves the open composer and body edits available without attachments", async () => {
  let draft: Draft = {
    ...emptyDraft("gmail:me"),
    mode: "forward",
    inReplyTo: "original",
    body: richComposeBody("<b>Edited while loading</b>"),
    includeOriginalAttachments: true,
  };
  let error = "";
  await Effect.runPromise(
    loadOriginalAttachments(
      Effect.fail("Download unavailable"),
      (files) => {
        draft = { ...draft, ...withOriginalAttachments(draft, files) };
      },
      (cause) => {
        draft = { ...draft, includeOriginalAttachments: false };
        error = Cause.pretty(cause);
      },
    ),
  );
  expect(draft.body.kind === "rich" ? draft.body.html : "").toContain("Edited while loading");
  expect(draft.includeOriginalAttachments).toBe(false);
  expect(error).toContain("Download unavailable");
});

it("async loads retain edits and convert unreferenced inline parts into sendable chips", () => {
  const draft = {
    ...emptyDraft("gmail:me"),
    inReplyTo: "original",
    body: richComposeBody('<b>Edited</b><img src="cid:kept@openmail">'),
  };
  const loaded = withOriginalAttachments(draft, [
    {
      filename: "kept.png",
      mimeType: "image/png",
      content: "aGk=",
      contentId: "kept@openmail",
      sourceMessageId: "original",
    },
    {
      filename: "chip.png",
      mimeType: "image/png",
      content: "aGk=",
      contentId: "absent@openmail",
      sourceMessageId: "original",
    },
  ]);
  expect(loaded.body).toBe(draft.body);
  expect(loaded.attachments[0]?.contentId).toBe("kept@openmail");
  expect(loaded.attachments[1]?.contentId).toBeUndefined();
  expect(loaded.attachments[1]?.content).toBe("aGk=");
  expect(inheritsOriginals({ ...draft, mode: "forward" }, "outlook")).toBe(true);
  expect(
    inheritsOriginals({ ...draft, mode: "forward", includeOriginalAttachments: false }, "outlook"),
  ).toBe(false);
});
