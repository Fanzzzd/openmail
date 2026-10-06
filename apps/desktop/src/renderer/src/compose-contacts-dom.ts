import { type Address, type InlineImageSize, INLINE_IMAGE_WIDTHS } from "@openmail/core/schema";

/** Only links created in this compose session own fresh recipients. Empty/unlinked names count as removed. */
export function activeComposeMentions(
  element: HTMLElement | null,
  created: ReadonlyMap<string, Address>,
): string[] {
  const active: string[] = [];
  for (const anchor of element?.querySelectorAll("a[data-compose-mention]") ?? []) {
    const person = created.get(anchor.getAttribute("data-compose-mention") ?? "");
    if (
      person &&
      anchor.textContent.trim() &&
      anchor.getAttribute("href")?.toLowerCase() === `mailto:${person.address.toLowerCase()}`
    )
      active.push(person.address);
  }
  return active;
}

export function resizeComposeImage(
  element: HTMLElement | null,
  cid: string | null,
  size: InlineImageSize,
): void {
  if (!cid) return;
  for (const image of element?.querySelectorAll("img") ?? []) {
    if (
      (image.getAttribute("data-compose-cid") ??
        image.getAttribute("src")?.replace(/^cid:/, "")) !== cid
    )
      continue;
    const width = INLINE_IMAGE_WIDTHS[size];
    image.removeAttribute("height");
    if (width === null) image.removeAttribute("width");
    else image.setAttribute("width", String(width));
  }
}
