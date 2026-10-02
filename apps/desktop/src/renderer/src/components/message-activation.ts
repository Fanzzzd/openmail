/** Received HTML can autofocus. Only trusted pointer/keyboard input selects its message. */
export function listenForMessageActivation(document: Document, activate: () => void) {
  const onInput = (event: Event) => {
    if (event.isTrusted) activate();
  };
  document.addEventListener("pointerdown", onInput);
  document.addEventListener("keydown", onInput);
  return () => {
    document.removeEventListener("pointerdown", onInput);
    document.removeEventListener("keydown", onInput);
  };
}
