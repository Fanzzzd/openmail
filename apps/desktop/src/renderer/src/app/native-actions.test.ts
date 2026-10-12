import { expect, it, vi } from "vitest";
import { dispatchNativeAction } from "./native-actions";
import { testDom } from "../test-support/test-dom";

it("native message commands act on the selection while editor commands reach the focused field", () => {
  const dom = testDom();
  class KeyEvent extends dom.window.Event {
    constructor(type: string, init: KeyboardEventInit) {
      super(type, { bubbles: init.bubbles, cancelable: init.cancelable });
      Object.assign(this, {
        key: init.key,
        metaKey: init.metaKey,
        ctrlKey: init.ctrlKey,
        altKey: init.altKey,
        shiftKey: init.shiftKey,
      });
    }
  }
  vi.stubGlobal("KeyboardEvent", KeyEvent);
  try {
    for (const tag of ["input", "textarea", "select", "div"]) {
      const field = dom.window.document.createElement(tag);
      if (tag === "div") field.setAttribute("contenteditable", "true");
      dom.window.document.body.append(field);
      Object.defineProperty(dom.window.document, "activeElement", {
        configurable: true,
        value: field,
      });
      const message = vi.fn();
      const editor = vi.fn();
      dom.window.document.body.addEventListener("keydown", message);
      field.addEventListener("keydown", editor);
      for (const action of ["reply", "trash", "sync", "send", "saveDraft"] as const)
        dispatchNativeAction("mimestream", action, true);
      expect(message).not.toHaveBeenCalled();
      dispatchNativeAction("mimestream", "reply", false);
      expect(editor).not.toHaveBeenCalled();
      expect(message).toHaveBeenCalledWith(expect.objectContaining({ key: "r", metaKey: true }));
      dispatchNativeAction("mimestream", "bold", true);
      expect(editor).toHaveBeenCalledWith(expect.objectContaining({ key: "b", metaKey: true }));
    }
  } finally {
    dom.dispose();
  }
});
