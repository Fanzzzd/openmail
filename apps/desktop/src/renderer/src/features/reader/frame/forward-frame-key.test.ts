// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { forwardFrameKey } from "./forward-frame-key";

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

/** A message frame document, a separate realm like the reader's sandboxed iframe. */
function frameDocument() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Missing frame document");
  doc.body.innerHTML = "<p>Body</p><input><div contenteditable>Note</div>";
  return doc;
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function windowKeys(handle?: (event: KeyboardEvent) => void) {
  const seen: KeyboardEvent[] = [];
  const listener = (event: KeyboardEvent) => {
    seen.push(event);
    handle?.(event);
  };
  window.addEventListener("keydown", listener);
  return { seen, stop: () => window.removeEventListener("keydown", listener) };
}

it("replays an unhandled frame key on the document so window shortcuts see it", () => {
  const doc = frameDocument();
  const keys = windowKeys((event) => event.preventDefault());
  doc.addEventListener("keydown", (event) => forwardFrameKey(event));
  try {
    const original = press(doc.body, "e", { shiftKey: false });
    expect(keys.seen.map((event) => [event.key, event.target])).toEqual([["e", document.body]]);
    // The window handled the copy, so the original is handled too and no menu key repeats it.
    expect(original.defaultPrevented).toBe(true);
    const chord = press(doc.body, "a", { metaKey: true, ctrlKey: true });
    expect(keys.seen.at(-1)).toMatchObject({ key: "a", metaKey: true, ctrlKey: true });
    expect(chord.defaultPrevented).toBe(true);
  } finally {
    keys.stop();
  }
});

it("leaves a key alone when the window does not handle it", () => {
  const doc = frameDocument();
  const keys = windowKeys();
  doc.addEventListener("keydown", (event) => forwardFrameKey(event));
  try {
    expect(press(doc.body, "PageDown").defaultPrevented).toBe(false);
    expect(keys.seen).toHaveLength(1);
  } finally {
    keys.stop();
  }
});

it("keeps typing, text selection keys and handled keys in the frame", () => {
  const doc = frameDocument();
  const keys = windowKeys((event) => event.preventDefault());
  doc.addEventListener("keydown", (event) => forwardFrameKey(event));
  const input = doc.querySelector("input");
  const editable = doc.querySelector("[contenteditable]");
  if (!input || !editable) throw new Error("Missing frame fields");
  try {
    expect(press(input, "e").defaultPrevented).toBe(false);
    expect(press(editable, "j").defaultPrevented).toBe(false);
    for (const key of ["c", "a", "x"]) {
      expect(press(doc.body, key, { metaKey: true }).defaultPrevented).toBe(false);
      expect(press(doc.body, key, { ctrlKey: true }).defaultPrevented).toBe(false);
    }
    const handled = new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true });
    handled.preventDefault();
    forwardFrameKey(handled);
    expect(keys.seen).toEqual([]);
  } finally {
    keys.stop();
  }
});
