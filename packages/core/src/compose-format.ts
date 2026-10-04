import { COMPOSE_FONT_FAMILIES, COMPOSE_FONT_SIZES } from "./domain.js";

export const COMPOSE_COLORS = [
  "#000000",
  "#666666",
  "#ffffff",
  "#cc0000",
  "#e69138",
  "#f1c232",
  "#38761d",
  "#134f5c",
  "#1155cc",
  "#674ea7",
] as const;
/** CSS is parsed as data, then serialized; no original declaration reaches the DOM. */
export function composeStyleValue(property: string, raw: string): string | undefined {
  if (/[\\/!*]/.test(raw) || /(?:url|expression|var)\s*\(/i.test(raw)) return undefined;
  const value = raw.trim();
  const lower = value.toLowerCase();
  switch (property) {
    case "font-family":
      return COMPOSE_FONT_FAMILIES.find(
        (f) => f.toLowerCase() === lower.replace(/^["']|["']$/g, ""),
      );
    case "font-size":
      return COMPOSE_FONT_SIZES.some((size) => `${size}px` === lower) ? lower : undefined;
    case "color":
    case "background-color": {
      if (/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value)) return lower;
      const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
      if (!rgb) return undefined;
      const channels = rgb.slice(1).map(Number);
      return channels.every((n) => n <= 255) ? `rgb(${channels.join(",")})` : undefined;
    }
    case "text-align":
      return ["left", "center", "right", "justify"].includes(lower) ? lower : undefined;
    case "direction":
      return ["ltr", "rtl"].includes(lower) ? lower : undefined;
    case "margin-left":
    case "padding-left":
      return /^(?:0|[1-9]\d{0,2})px$/.test(lower) && Number.parseInt(lower) <= 240
        ? lower
        : undefined;
    case "text-decoration":
      return ["underline", "line-through", "underline line-through"].includes(lower)
        ? lower
        : undefined;
    default:
      return undefined;
  }
}
export function composeStyle(input: string): string {
  const styles = new Map<string, string>();
  for (const declaration of input.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = composeStyleValue(property, declaration.slice(colon + 1));
    if (value !== undefined) styles.set(property, value);
  }
  return [...styles].map(([p, v]) => `${p}:${v}`).join(";");
}
export type ComposeReplacement =
  | { start: number; end: number; tag: "strong" | "em" | "s" | "code"; text: string }
  | { start: number; end: number; block: "ul" | "ol" | "blockquote" | "pre"; dashed: boolean };
/** Only the caret's current text node is scanned, outside code/links and after IME commits. */
export function composeReplacement(
  text: string,
  markdown: boolean,
  lists: boolean,
): ComposeReplacement | undefined {
  const normalized = text.replaceAll("\u00a0", " ");
  if (lists && /^(?:\* |- )$/.test(normalized))
    return { start: 0, end: text.length, block: "ul", dashed: normalized.startsWith("-") };
  if (lists && /^1\. $/.test(normalized))
    return { start: 0, end: text.length, block: "ol", dashed: false };
  if (!markdown) return undefined;
  if (normalized === "> " || normalized === "``` ")
    return {
      start: 0,
      end: text.length,
      block: normalized === "> " ? "blockquote" : "pre",
      dashed: false,
    };
  for (const [mark, tag] of [
    ["**", "strong"],
    ["~~", "s"],
    ["`", "code"],
    ["*", "em"],
    ["_", "em"],
  ] as const) {
    if (!normalized.endsWith(mark)) continue;
    const end = normalized.length - mark.length;
    const start = normalized.lastIndexOf(mark, end - 1);
    if (
      start < 0 ||
      start === end ||
      (start && /[\p{L}\p{N}\\]/u.test(normalized.charAt(start - 1)))
    )
      continue;
    const contents = normalized.slice(start + mark.length, end);
    if (!contents || /^\s|\s$/.test(contents) || contents.includes(mark)) continue;
    return { start, end: text.length, tag, text: contents };
  }
  return undefined;
}
