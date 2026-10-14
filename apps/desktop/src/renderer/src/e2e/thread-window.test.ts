import { afterEach, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react/pure";
import { constVoid } from "effect/Function";
import { eventually, flow, wait } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  for (const input of document.querySelectorAll("input[data-test-field]")) input.remove();
});

async function threadWindow(options: Parameters<typeof flow>[0] = {}) {
  current = await flow({ thread: "one", ...options });
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
      "Original one",
    ),
  );
  return current;
}
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
const tags = (h: Awaited<ReturnType<typeof flow>>, from = 0) =>
  h.requests.slice(from).map((request) => request.tag);
/** An editable field outside the reader, focused. */
function focusedField() {
  const input = document.createElement("input");
  input.dataset.testField = "";
  document.body.append(input);
  input.focus();
  return input;
}

it("reader windows handle compose/new-window/settings rather than losing their accelerators", async () => {
  const h = await threadWindow();
  expect(press("n", { metaKey: true }).defaultPrevented).toBe(true);
  await eventually(() => expect(tags(h).at(-1)).toBe("ComposeNew"));
  expect(press("N", { metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  await eventually(() => expect(tags(h).at(-1)).toBe("NewWindow"));
  expect(press(",", { metaKey: true }).defaultPrevented).toBe(true);
  await eventually(() => expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy());
});

it("window shortcut registration never disables native menu shortcuts on focus changes", async () => {
  const h = await threadWindow();
  const input = focusedField();
  input.blur();
  input.focus();
  const before = h.requests.length;
  // Keys reach the focused field; its edit commands and Close and Quit stay with the menu.
  expect(
    ["c", "v", "x", "a", "z", "w", "q"].filter(
      (key) => press(key, { metaKey: true }, input).defaultPrevented,
    ),
  ).toEqual([]);
  await wait(50);
  expect(tags(h, before)).toEqual([]);
});

it("removeLabel without a window label trashes but keeps its explanation visible", async () => {
  const close = vi.spyOn(window, "close").mockImplementation(constVoid);
  const h = await threadWindow({ prefs: { deleteKeyAction: "removeLabel" } });
  press("Backspace");
  await eventually(() =>
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent === "No current label applies. Moving to Trash."),
    ).toBe(true),
  );
  await eventually(async () =>
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("TRASH"),
  );
  expect(tags(h).filter((tag) => tag === "Modify" || tag === "ModifyMessages")).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
});

it("reader native accelerators do not reply or delete while an editable field is focused", async () => {
  const h = await threadWindow();
  focusedField();
  const before = h.requests.length;
  await h.event({ _tag: "NativeAction", action: "reply", triggeredByAccelerator: true });
  await h.event({ _tag: "NativeAction", action: "trash", triggeredByAccelerator: true });
  await wait(50);
  expect(tags(h, before)).toEqual([]);
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("TRASH");
  await h.event({ _tag: "NativeAction", action: "reply", triggeredByAccelerator: false });
  await eventually(() => expect(tags(h, before)).toContain("ComposeMessage"));
});
