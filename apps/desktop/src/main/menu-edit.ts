import type { WebContents } from "electron";

const editableFocus = `(() => {
  let element = document.activeElement;
  while (element?.tagName === "IFRAME") {
    try { element = element.contentDocument?.activeElement; } catch { return true; }
  }
  return Boolean(element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
})()`;

/** Native text undo stays in Chromium; mail undo belongs to the main renderer. */
export async function menuEdit(
  contents: Pick<WebContents, "executeJavaScript" | "undo" | "selectAll">,
  action: "undo" | "selectAll",
  appEdit: () => void,
): Promise<void> {
  // Failed/closing renderers must not turn a text undo into a mail mutation.
  const editable = await contents.executeJavaScript(editableFocus).catch(() => true);
  if (editable === true) {
    if (action === "undo") contents.undo();
    else contents.selectAll();
  } else appEdit();
}
