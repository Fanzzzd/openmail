/** Re-query and click in one renderer turn. A completed navigation is never clicked again. */
export function smokeClickExpression(selector, ready) {
  return `(() => {
    const ready = ${JSON.stringify(ready ?? null)};
    if (ready && document.querySelector(ready)) return true;
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || !element.isConnected || element.disabled) return false;
    element.click();
    return ready ? !!document.querySelector(ready) : true;
  })()`;
}

export function isBlockedSmokeImage(source, text) {
  return (
    source === "about:srcdoc" &&
    (/^Loading the image '[^\r\n]*' violates the following Content Security Policy directive: "img-src data: cid:"\. The action has been blocked\.$/.test(
      text,
    ) ||
      /^Refused to load the image '[^\r\n]*' because it violates the following Content Security Policy directive: "img-src data: cid:"\.$/.test(
        text,
      ))
  );
}
