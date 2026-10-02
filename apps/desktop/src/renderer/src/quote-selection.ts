/** Read only the chosen reader message, including its scriptless same-origin iframe. */
export function readerSelectedText(document: Document, id: string): string | undefined {
  for (const message of document.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (message.dataset.messageId !== id) continue;
    for (const frame of message.querySelectorAll("iframe")) {
      const focused = frame.contentDocument?.hasFocus() || document.activeElement === frame;
      if (!focused) continue;
      const text = frame.contentDocument?.getSelection()?.toString();
      if (text?.trim()) return text;
    }
    const selection = document.getSelection();
    if (
      selection?.rangeCount &&
      message.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      const text = selection.toString();
      if (text.trim()) return text;
    }
  }
  return undefined;
}

export function quoteChoice(
  preference: "ask" | "always" | "never",
  selected: string | undefined,
): "ask" | "selection" | "whole" {
  return !selected?.trim() || preference === "never"
    ? "whole"
    : preference === "ask"
      ? "ask"
      : "selection";
}
