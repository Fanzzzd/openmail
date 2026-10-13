/**
 * Resource URLs as a browser reads them, shared by `prepareMessageHtml` and
 * `sanitizeReaderHtml`. Both decide on parsed attributes and CSS nodes, never
 * on regex-matched markup. No Node dependencies.
 */
import { ident, parse, walk, type CssNode } from "./css-tree-browser.js";

/**
 * The URL text a browser parses: it removes ASCII tab and newline anywhere and
 * trims C0 controls and spaces at both ends before parsing.
 */
export const browserUrlText = (value: string): string =>
  value.replace(/[\t\n\r]/g, "").replace(/^[\0-\x20]+|[\0-\x20]+$/g, "");

/**
 * The http(s) URL a browser would load for `value`, or undefined. A
 * protocol-relative URL without a base counts as HTTPS. WHATWG parsing
 * lowercases and IDNA-maps the host, percent-decodes it, and resolves `.`
 * and `..` path segments, including their percent-encoded forms.
 */
export function webUrl(value: string, base?: string): URL | undefined {
  const text = browserUrlText(value);
  if (!text) return undefined;
  try {
    const url =
      base === undefined
        ? new URL(/^[\\/]{2}/.test(text) ? `https:${text}` : text)
        : new URL(text, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** One `srcset` image candidate. */
export interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

const isSpace = (character: string | undefined) =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\f" ||
  character === "\r";

/**
 * Splits `srcset` as the HTML standard does: a URL is a run of non-space
 * characters (so it may contain commas), and descriptors run to the next
 * comma outside parentheses.
 */
export function srcsetCandidates(input: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && (isSpace(input[i]) || input[i] === ",")) i++;
    if (i >= input.length) break;
    let start = i;
    while (i < input.length && !isSpace(input[i])) i++;
    let url = input.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      start = i;
      let depth = 0;
      for (; i < input.length; i++) {
        const character = input[i];
        if (character === "(") depth++;
        else if (character === ")") depth = Math.max(0, depth - 1);
        else if (character === "," && depth === 0) break;
      }
      descriptor = input.slice(start, i).trim();
      i++;
    }
    if (url) candidates.push({ url, descriptor });
  }
  return candidates;
}

/** An image whose rendered width or height is below this is an open pixel. */
const PIXEL_LIMIT = 2;

/**
 * CSS lengths in px. Font-relative units use the 16 px default; viewport
 * units a 320 px viewport, so a length that is tiny on a phone counts.
 */
const CSS_PX: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 16,
  rem: 16,
  ex: 8,
  ch: 8,
  vw: 3.2,
  vh: 3.2,
  vmin: 3.2,
  vmax: 3.2,
};
const SIZE_PROPERTIES = new Set([
  "width",
  "height",
  "max-width",
  "max-height",
  "inline-size",
  "block-size",
  "max-inline-size",
  "max-block-size",
]);

/** An HTML `width`/`height` value in px, per the dimension-value rules; undefined for percentages. */
function attributePx(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^[\t\n\f\r ]*(\d+(?:\.\d*)?|\.\d+)(%?)/.exec(value);
  return match?.[1] && !match[2] ? Number(match[1]) : undefined;
}

/** A single CSS length in px, or undefined for percentages, keywords and math. */
function cssPx(node: CssNode | null | undefined): number | undefined {
  if (node?.type === "Number") return Number(node.value) === 0 ? 0 : undefined;
  if (node?.type !== "Dimension") return undefined;
  const scale =
    CSS_PX[
      ident
        .decode(node.unit)
        .toLowerCase()
        .replace(/^[sld](?=v)/, "")
    ];
  return scale === undefined ? undefined : Number(node.value) * scale;
}

/** The smallest width or height an inline style gives, in px. */
function styleSizes(style: string): number[] {
  const sizes: number[] = [];
  try {
    walk(parse(style, { context: "declarationList" }), (node) => {
      if (node.type !== "Declaration" || node.value.type !== "Value") return;
      if (!SIZE_PROPERTIES.has(ident.decode(node.property).toLowerCase())) return;
      if (node.value.children.size !== 1) return;
      const px = cssPx(node.value.children.first);
      if (px !== undefined) sizes.push(px);
    });
  } catch {
    /* An unreadable style gives no size. */
  }
  return sizes;
}

/**
 * Whether an image renders under 2 px wide or tall, from its `width` and
 * `height` attributes or inline style, in px or fractions of other units.
 * Either source is enough: a hidden dimension is still a loaded request.
 */
export function isPixelImage(attribs: Readonly<Record<string, string | undefined>>): boolean {
  const sizes = [attributePx(attribs.width), attributePx(attribs.height)].filter(
    (size) => size !== undefined,
  );
  if (attribs.style) sizes.push(...styleSizes(attribs.style));
  return sizes.some((size) => size < PIXEL_LIMIT);
}
