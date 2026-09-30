/** The parent reads DOM events directly. No script or postMessage runs in the mail. */
export function linkTargetUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    url.username = "";
    url.password = "";
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function listenForLinkHints(
  source: EventTarget,
  target: (event: Event) => string | null,
  show: (url: string | null) => void,
): () => void {
  const read = (event: Event) => {
    if (event.currentTarget === source) show(target(event));
  };
  const clear = () => show(null);
  const reads = ["mouseover", "mousemove", "focusin"];
  const clears = ["mouseout", "mouseleave", "focusout", "blur"];
  for (const name of reads) source.addEventListener(name, read);
  for (const name of clears) source.addEventListener(name, clear);
  return () => {
    for (const name of reads) source.removeEventListener(name, read);
    for (const name of clears) source.removeEventListener(name, clear);
    clear();
  };
}

export function frameLinkTarget(doc: Document, event: Event): string | null {
  const element =
    "clientX" in event &&
    typeof event.clientX === "number" &&
    "clientY" in event &&
    typeof event.clientY === "number"
      ? doc.elementFromPoint(event.clientX, event.clientY)
      : doc.activeElement;
  const link = element?.closest("a,area");
  if (link?.ownerDocument !== doc) return null;
  const value =
    link.getAttribute("href") ??
    link.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
    link.getAttribute("xlink:href");
  const href = "href" in link ? link.href : undefined;
  const target =
    typeof href === "string"
      ? href
      : typeof href === "object" &&
          href !== null &&
          "animVal" in href &&
          typeof href.animVal === "string"
        ? href.animVal
        : typeof href === "object" &&
            href !== null &&
            "baseVal" in href &&
            typeof href.baseVal === "string"
          ? href.baseVal
          : value;
  return linkTargetUrl(target, link.baseURI || doc.baseURI);
}

/** SVG anchors do not inherit the HTML base target. Force the existing popup route. */
export function externalLinkTargets(doc: Document): void {
  for (const link of doc.querySelectorAll("a,area")) link.setAttribute("target", "_blank");
}
