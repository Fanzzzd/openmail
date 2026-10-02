import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import {
  inlineImageHtml,
  mentionHtml,
  richComposeBody,
  reconcileMentionRecipients,
  DEFAULT_PREFS,
} from "@openmail/core/schema";
import { activeComposeMentions, resizeComposeImage } from "./compose-contacts-dom";
import { composeEditorHtml, editorBody } from "./compose-editor-dom";
import { emptyDraft, toMessage, fromStored } from "./draft";

afterEach(() => vi.unstubAllGlobals());
const person = { name: "Alice", address: "alice@example.com" };
const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
function editor(html: string) {
  const { document, window } = parseHTML(`<div id="editor">${html}</div>`);
  vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  vi.stubGlobal("HTMLDivElement", window.HTMLDivElement);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  const element = document.querySelector("div");
  if (!element) throw new Error("Missing editor");
  return element;
}

it("fresh mention recipient persists while either name link remains; deleting, emptying or unlinking the last removes it, undo restores it", () => {
  const element = editor(
    mentionHtml(person, first) +
      mentionHtml(person, second) +
      mentionHtml(
        { name: "Old", address: "old@example.com" },
        "00000000-0000-4000-8000-000000000003",
      ),
  );
  const created = new Map([
    [first, person],
    [second, person],
  ]);
  const saved = { name: "Saved", address: "saved@example.com" };
  const ownership = new Set([person.address]);
  const recipients = (to: (typeof person)[]) =>
    reconcileMentionRecipients(
      to,
      [],
      activeComposeMentions(element, created).map(() => person),
      ownership,
    ).to;
  expect(recipients([saved, person])).toEqual([saved, person]);
  element.querySelector(`[data-compose-mention="${first}"]`)?.remove();
  expect(recipients([saved, person])).toEqual([saved, person]);
  const remaining = element.querySelector(`[data-compose-mention="${second}"]`);
  if (!remaining) throw new Error("Missing mention");
  const html = element.innerHTML;
  remaining.textContent = "";
  expect(recipients([saved, person])).toEqual([saved]);
  element.innerHTML = html;
  expect(recipients([saved])).toEqual([saved, person]);
  element.querySelector(`[data-compose-mention="${second}"]`)?.removeAttribute("href");
  expect(recipients([saved, person])).toEqual([saved]);
});

it("resizing a selected blob preview retains CID, other images, font metadata and a single safe numeric width", () => {
  const image = {
    filename: "one.png",
    content: "AAEC",
    mimeType: "image/png",
    contentId: "one@openmail",
  };
  const body = {
    ...richComposeBody(
      inlineImageHtml(image, "small") +
        inlineImageHtml({ ...image, contentId: "two@openmail" }, "large"),
    ),
    font: DEFAULT_PREFS.composeFont,
  };
  const element = editor(body.html);
  const selected = element.querySelector("img");
  if (!selected) throw new Error("Missing image");
  selected.setAttribute("data-compose-cid", image.contentId);
  selected.setAttribute("src", "blob:local-preview");
  resizeComposeImage(element, image.contentId, "medium");
  const html = composeEditorHtml(element);
  expect(html).toContain('src="cid:one@openmail"');
  expect(html).toContain('width="320"');
  expect(html).toContain('width="640"');
  expect(html).not.toContain("blob:");
  expect(editorBody(element, body)).toMatchObject({
    font: DEFAULT_PREFS.composeFont,
    html: expect.stringContaining('width="320"'),
  });
  resizeComposeImage(element, image.contentId, "original");
  expect(selected.hasAttribute("width")).toBe(false);
  expect(element.querySelectorAll("img")[1]?.getAttribute("width")).toBe("640");
});

it("UI rich draft saves and reopens its default font without placing styles inside editable HTML", () => {
  const draft = emptyDraft("gmail:me@example.com");
  draft.to = person.address;
  draft.body = { ...richComposeBody("<b>Hello</b>"), font: { family: "Georgia", size: 18 } };
  const message = toMessage(draft).message;
  expect(message.composeFont).toEqual({ family: "Georgia", size: 18 });
  expect(message.html).toBe("<strong>Hello</strong>");
  const reopened = fromStored({
    id: draft.id,
    accountId: draft.accountId,
    message,
    updatedAt: 1,
    synced: false,
    proposalId: null,
  });
  expect(reopened.body).toMatchObject({
    font: { family: "Georgia", size: 18 },
    html: "<strong>Hello</strong>",
  });
});
