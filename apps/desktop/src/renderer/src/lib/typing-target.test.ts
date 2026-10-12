import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { isTypingTarget } from "./typing-target";

const { document } = parseHTML(`<html><body>
  <input id="text"><input id="box" type="checkbox"><textarea id="area"></textarea>
  <select id="pick"><option id="choice">One</option></select>
  <div contenteditable="true" id="editor"><p><span id="nested">Text</span></p>
    <div contenteditable="false" id="locked"><span id="locked-child">Chip</span></div></div>
  <div contenteditable="" id="empty"></div>
  <div contenteditable="false" id="off"></div>
  <button id="button">Send</button>
</body></html>`);
const target = (id: string) => document.getElementById(id);

it("treats inputs, textareas and selects as typing", () => {
  for (const id of ["text", "box", "area", "pick", "choice"])
    expect(isTypingTarget(target(id))).toBe(true);
});

it("treats editable content, nested children included, as typing", () => {
  for (const id of ["editor", "nested", "empty"]) expect(isTypingTarget(target(id))).toBe(true);
});

it('does not treat contenteditable="false" or other elements as typing', () => {
  for (const id of ["off", "locked", "locked-child", "button"])
    expect(isTypingTarget(target(id))).toBe(false);
  expect(isTypingTarget(null)).toBe(false);
});
