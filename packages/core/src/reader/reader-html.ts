/**
 * Prepares untrusted mail HTML for the reader and for printing. It only
 * rewrites resource URLs; the sandboxed iframe and its CSP stay the security
 * boundary, and `sanitizeReaderHtml` repeats the tracker and pixel checks on
 * its parsed tree. No Node dependencies; exported through `@openmail/core/schema`.
 *
 * htmlparser2 tokenizes the markup and css-tree the CSS. Each changed tag or
 * CSS value is spliced back at its source offsets, so the rest of the message
 * stays byte for byte.
 */
import { Parser } from "htmlparser2";
import { stripMessageIdBrackets } from "../mime/message-id.js";
import { ident, parse, walk } from "./css-tree-browser.js";
import { browserUrlText, isPixelImage, srcsetCandidates, webUrl } from "./resource-url.js";
import { trackerForUrl } from "./trackers.js";

export interface PreparedHtml {
  html: string;
  /** Tracking services whose URLs were removed, each once. */
  trackers: string[];
  /** Remote images under 2 px wide or tall from hosts not on the list, removed as likely open pixels. */
  pixels: number;
  /** Remote images or styles are left that the CSP blocks until images are allowed. */
  hasRemote: boolean;
  /** Resources reference embedded parts by `cid:`. */
  hasCid: boolean;
}

export interface PrepareOptions {
  /** Inline parts by Content-ID (without angle brackets), as data: URLs. Replaces `cid:` references. */
  inline?: Readonly<Record<string, string>>;
}

/** What a removed resource points to: an empty data URL loads nothing. */
const EMPTY = "data:,";

/** Attributes that load a resource by themselves. */
const RESOURCE_ATTRS = new Set(["src", "background", "poster", "data", "lowsrc", "dynsrc"]);
/** Attributes holding an image candidate list. */
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
const HREF_ATTRS = new Set(["href", "xlink:href"]);
/** Elements whose `href` loads a resource rather than navigating. */
const RESOURCE_HREF_TAGS = new Set(["link", "image", "use", "feimage"]);
/** CSS functions whose top-level strings are resource URLs. */
const STRING_RESOURCE_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "image", "src"]);
/** Attribute names that serialize and reparse as themselves. */
const ATTRIBUTE_NAME = /^[^\s"'<>/=\0]+$/;

interface Tag {
  start: number;
  end: number;
  name: string;
  attribs: Record<string, string>;
  selfClosing: boolean;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Open tags as written (not ones implied by an end tag) and `<style>` text ranges. */
function scan(html: string): { tags: Tag[]; styles: { start: number; end: number }[] } {
  const tags: Tag[] = [];
  const styles: { start: number; end: number }[] = [];
  let styleStart = -1;
  const parser = new Parser({
    onopentag: (name, attribs) => {
      const { startIndex: start, endIndex: end } = parser;
      if (html[start] !== "<" || html[start + 1] === "/") return;
      tags.push({ start, end: end + 1, name, attribs, selfClosing: html[end - 1] === "/" });
      if (name === "style") styleStart = end + 1;
    },
    onclosetag: (name, implied) => {
      if (name !== "style" || styleStart < 0) return;
      // An implied end is either the end of input or a self-closed SVG style.
      const end = implied ? Math.max(styleStart, parser.startIndex) : parser.startIndex;
      styles.push({ start: styleStart, end });
      styleStart = -1;
    },
  });
  parser.end(html);
  return { tags, styles };
}

const splice = (text: string, edits: readonly Edit[]) => {
  if (!edits.length) return text;
  let out = "";
  let cursor = 0;
  for (const edit of edits.toSorted((a, b) => a.start - b.start)) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
};

/** A CSS string body for `quote`. */
const cssString = (value: string, quote: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(quote, `\\${quote}`)
    .replace(/[\n\r\f]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `);

const attributeValue = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

export function prepareMessageHtml(html: string, options: PrepareOptions = {}): PreparedHtml {
  const trackers: string[] = [];
  let pixels = 0;
  let hasRemote = false;
  let hasCid = false;
  const { tags, styles } = scan(html);

  // The first HTML base href, entity-decoded. Only an absolute web URL can
  // supply a base; all base elements are removed before rendering.
  let base: string | undefined;
  const baseHref = tags.find((tag) => tag.name === "base" && tag.attribs.href !== undefined)
    ?.attribs.href;
  if (baseHref !== undefined) {
    const url = webUrl(baseHref);
    // An invalid base must not redirect relative resources to an app URL.
    if (url && !/^[\\/]{2}/.test(browserUrlText(baseHref))) {
      url.username = "";
      url.password = "";
      base = url.href;
    }
  }

  const note = (name: string) => {
    if (!trackers.includes(name)) trackers.push(name);
  };

  /** A resource URL as it should load: removed for trackers, inlined for cid:, upgraded to HTTPS. */
  const resource = (value: string): string => {
    const text = browserUrlText(value);
    if (/^cid:/i.test(text)) {
      hasCid = true;
      try {
        const id = stripMessageIdBrackets(decodeURIComponent(text.slice(4)));
        return options.inline?.[id] ?? value;
      } catch {
        return value;
      }
    }
    const url = webUrl(text, base);
    if (!url) return value;
    const tracker = trackerForUrl(url);
    if (tracker) {
      note(tracker);
      return EMPTY;
    }
    hasRemote = true;
    // The app has a secure origin. Opted-in resources use HTTPS rather than
    // relying on Chromium's mixed-content exceptions for HTTP images.
    url.protocol = "https:";
    return url.href === value ? value : url.href;
  };

  /** Rewrites url(), image-set and @import strings, read by css-tree. */
  const css = (text: string, inline: boolean): string => {
    const edits: Edit[] = [];
    try {
      const ast = parse(text, {
        context: inline ? "declarationList" : "stylesheet",
        positions: true,
        parseCustomProperty: true,
      });
      walk(ast, function (node) {
        if (!node.loc) return;
        const { offset: start } = node.loc.start;
        const { offset: end } = node.loc.end;
        if (node.type === "Url") {
          const next = resource(node.value);
          if (next === node.value) return;
          const written = /^url\(\s*(["']?)/i.exec(text.slice(start, end))?.[1] ?? "";
          const quote = written || (/['"()\s\\]/.test(next) ? '"' : "");
          const value = quote ? cssString(next, quote) : next;
          edits.push({ start, end, text: `url(${quote}${value}${quote})` });
        } else if (node.type === "String") {
          const holder = this.function
            ? STRING_RESOURCE_FUNCTIONS.has(ident.decode(this.function.name).toLowerCase())
            : this.atrulePrelude &&
              this.atrule !== null &&
              ident.decode(this.atrule.name).toLowerCase() === "import";
          if (!holder) return;
          const next = resource(node.value);
          if (next === node.value) return;
          const quote = text[start] === "'" ? "'" : '"';
          edits.push({ start, end, text: `${quote}${cssString(next, quote)}${quote}` });
        }
      });
    } catch {
      // The sanitizer drops what css-tree cannot read.
      return text;
    }
    return splice(text, edits);
  };

  const srcset = (value: string) => {
    let changed = false;
    const candidates: string[] = [];
    for (const { url, descriptor } of srcsetCandidates(value)) {
      const next = resource(url);
      if (next !== url) changed = true;
      if (next === EMPTY && url !== EMPTY) continue;
      candidates.push(descriptor ? `${next} ${descriptor}` : next);
    }
    return changed ? candidates.join(", ") : value;
  };

  /** A navigation link resolved against the base, not upgraded. */
  const link = (value: string) => {
    try {
      return base ? new URL(browserUrlText(value), base).href : value;
    } catch {
      return value;
    }
  };

  /** The tag as it should be written, or undefined when it stays as it is. */
  const rewriteTag = ({ name, attribs, selfClosing }: Tag): string | undefined => {
    if (name === "base") return "";
    if (name === "link" && (attribs.rel ?? "").trim().toLowerCase() !== "stylesheet") return "";

    // Tracker images go away whole, so no broken-image icon is left behind.
    // An image under 2 px wide or tall from an unlisted remote host is an open
    // pixel too. Parsers read <image> outside SVG as <img> (htmlparser2 12 does).
    if (
      name === "img" ||
      name === "image" ||
      (name === "input" && attribs.type?.trim().toLowerCase() === "image")
    ) {
      const source = attribs.src ?? attribs.href ?? attribs["xlink:href"];
      const url = source === undefined ? undefined : webUrl(source, base);
      const tracker = url && trackerForUrl(url);
      if (tracker) {
        note(tracker);
        return "";
      }
      if (url && isPixelImage(attribs)) {
        pixels++;
        return "";
      }
    }

    let changed = false;
    const written: string[] = [];
    for (const [key, value] of Object.entries(attribs)) {
      let next = value;
      if (RESOURCE_ATTRS.has(key) || (HREF_ATTRS.has(key) && RESOURCE_HREF_TAGS.has(name)))
        next = resource(value);
      else if (SRCSET_ATTRS.has(key)) next = srcset(value);
      else if (key === "style") next = css(value, true);
      else if (HREF_ATTRS.has(key)) next = link(value);
      if (next !== value) changed = true;
      // A name the tokenizer accepted only as an error is not written back.
      if (ATTRIBUTE_NAME.test(key)) written.push(`${key}="${attributeValue(next)}"`);
    }
    if (!changed) return undefined;
    return `<${name}${written.map((attribute) => ` ${attribute}`).join("")}${selfClosing ? " /" : ""}>`;
  };

  const edits: Edit[] = [];
  for (const tag of tags) {
    const text = rewriteTag(tag);
    if (text !== undefined) edits.push({ start: tag.start, end: tag.end, text });
  }
  for (const style of styles) {
    const source = html.slice(style.start, style.end);
    const text = css(source, false);
    if (text !== source) edits.push({ ...style, text });
  }
  return { html: splice(html, edits), trackers, pixels, hasRemote, hasCid };
}
