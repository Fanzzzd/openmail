import { expect, it } from "vitest";
import { restoreMobileRichText, richComposeBody } from "@openmail/core/portable";
import { editMarks, richTextBody } from "./rich-text";
it("reopens bold/italic drafts and retains both marks through their first edit", () => {
  const html = "<strong>Hello</strong> <em> world</em>";
  const editor = restoreMobileRichText({ html, text: richComposeBody(html).text });
  expect(editor.text).toBe("Hello world");
  const text = "Hello worlds";
  const edited = richTextBody(text, editMarks(editor.text, text, editor.marks), editor.list);
  expect(edited.html).toContain("<strong>Hello</strong>");
  expect(edited.html).toContain("<em> world</em>");
  const inside = "Hullo world";
  expect(
    richTextBody(inside, editMarks(editor.text, inside, editor.marks), editor.list).html,
  ).toContain("<strong>Hullo</strong>");
});
it("restores lists without duplicating text-alternative bullet markers", () => {
  const html = "<ul><li><strong>one</strong></li><li><em>two</em></li></ul>";
  const editor = restoreMobileRichText({ html, text: richComposeBody(html).text });
  expect(editor).toMatchObject({ text: "one\ntwo", list: true });
  const text = "one\ntwice";
  const updated = richTextBody(text, editMarks(editor.text, text, editor.marks), editor.list);
  expect(updated.html).toContain("<ul>");
  expect(updated.html).toContain("<strong>one</strong>");
  expect(updated.html).toContain("<em>twice</em>");
  expect(updated.html).not.toContain("- one");
});
