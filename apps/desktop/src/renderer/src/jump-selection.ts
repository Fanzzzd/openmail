/** Scroll the existing selection into view without replacing it or changing the find query. */
export function jumpDocumentSelection(document: Document): boolean {
  const selection = document.getSelection();
  if (!selection?.rangeCount) return false;
  const node = selection.getRangeAt(0).startContainer;
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (!element || !("scrollIntoView" in element) || typeof element.scrollIntoView !== "function")
    return false;
  element.scrollIntoView({ block: "center", inline: "nearest" });
  return true;
}
export function jumpReaderSelection(document: Document, id: string): boolean {
  const message = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find(
    (element) => element.dataset.messageId === id,
  );
  if (!message) return false;
  for (const frame of message.querySelectorAll("iframe")) {
    const content = frame.contentDocument;
    if (
      content &&
      (content.hasFocus() || document.activeElement === frame) &&
      jumpDocumentSelection(content)
    )
      return true;
  }
  const selection = document.getSelection();
  return Boolean(
    selection?.rangeCount &&
    message.contains(selection.getRangeAt(0).startContainer) &&
    jumpDocumentSelection(document),
  );
}

/** Measure wrapped text up to the selection using the textarea's actual font and width. */
export function jumpTextareaSelection(element: HTMLTextAreaElement): void {
  const document = element.ownerDocument;
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  const computed = window.getComputedStyle(element);
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "letter-spacing",
    "line-height",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "box-sizing",
    "word-break",
    "tab-size",
  ]) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: "fixed",
    top: "0",
    left: "0",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    width: `${element.clientWidth}px`,
  });
  mirror.textContent = element.value.slice(0, element.selectionStart);
  marker.textContent =
    element.value.slice(element.selectionStart, element.selectionEnd) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  try {
    element.focus({ preventScroll: true });
    element.scrollTop = Math.max(0, marker.offsetTop - element.clientHeight / 2);
  } finally {
    mirror.remove();
  }
}
