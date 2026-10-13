import { stripMessageIdBrackets } from "../mime/message-id.js";
/**
 * Prepares untrusted mail HTML for the reader and for printing. It only
 * rewrites resource URLs; the sandboxed iframe and its CSP stay the security
 * boundary. No Node dependencies; exported through `@openmail/core/schema`.
 */
import { trackerFor } from "./trackers.js";
import { Parser } from "htmlparser2";

export interface PreparedHtml {
  html: string;
  /** Tracking services whose URLs were removed, each once. */
  trackers: string[];
  /** 1×1 remote images from hosts not on the list, removed as likely open pixels. */
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

const TAG =
  /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
/** Attributes that load a resource by themselves. `href` only loads on <link>. */
const RESOURCE_ATTRS = new Set(["src", "background", "poster", "data", "lowsrc", "dynsrc"]);

const isRemote = (url: string) => /^\s*(https?:)?\/\//i.test(url);

const unquote = (value: string) =>
  value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;

/** A dimension of 0 or 1 pixel, from an attribute or inline style. */
const tiny = (value: string | undefined) => value !== undefined && /^\s*[01](px)?\s*$/i.test(value);

function styleDimension(style: string | undefined, name: string): string | undefined {
  if (!style) return undefined;
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style);
  return match?.[1];
}

const attributeText = (value: string) => {
  if (!value.includes("&")) return value;
  let decoded = value;
  new Parser({
    onopentag: (_name, attrs) => {
      decoded = attrs.value ?? value;
    },
  }).end(`<a value="${value.replaceAll('"', "&quot;")}">`);
  return decoded;
};
const attributeUrl = (value: string) => value.replaceAll("&", "&amp;");

/** CSS escapes are decoded before deciding whether a URL or declaration is concealed. */
export function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_whole, escaped: string) => {
    const hex = /^[0-9a-f]{1,6}\s?$/i.test(escaped) ? parseInt(escaped.trim(), 16) : null;
    return hex === null
      ? escaped
      : hex > 0 && hex <= 0x10ffff
        ? String.fromCodePoint(hex)
        : "\uFFFD";
  });
}

/** Strings at the top level of image-set are resources; nested type() strings are MIME types. */
function rewriteImageSets(text: string, resource: (value: string) => string): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(/(?:-webkit-)?image-set\s*\(/gi)) {
    if (match.index < cursor) continue;
    let i = match.index + match[0].length;
    out += text.slice(cursor, i);
    let depth = 1;
    while (i < text.length && depth > 0) {
      const character = text[i];
      if (character === '"' || character === "'") {
        const start = ++i;
        while (i < text.length && text[i] !== character) {
          if (text[i] === "\\") i++;
          i++;
        }
        const value = text.slice(start, i);
        const next = depth === 1 ? resource(value) : value;
        out +=
          character +
          (next === value
            ? value
            : next.replaceAll("\\", "\\\\").replaceAll(character, `\\${character}`));
        if (i < text.length) out += character;
      } else {
        if (character === "(") depth++;
        if (character === ")") depth--;
        out += character;
      }
      i++;
    }
    cursor = i;
  }
  return out + text.slice(cursor);
}

export function prepareMessageHtml(html: string, options: PrepareOptions = {}): PreparedHtml {
  const trackers: string[] = [];
  let pixels = 0;
  let hasRemote = false;
  let hasCid = false;

  // Read the first HTML base href with entity decoding. Only an absolute web
  // URL can supply a base; all base elements are removed before rendering.
  let base: string | undefined;
  let sawBase = false;
  new Parser({
    onopentag: (name, attrs) => {
      if (name !== "base" || sawBase || attrs.href === undefined) return;
      sawBase = true;
      try {
        const url = new URL(attrs.href);
        if (url.protocol === "https:" || url.protocol === "http:") {
          url.username = "";
          url.password = "";
          base = url.href;
        }
      } catch {
        /* An invalid base must not redirect relative resources to an app URL. */
      }
    },
  }).end(html);

  const absolute = (value: string, attribute = false) => {
    const decoded = attribute ? attributeText(value) : value;
    try {
      return base ? new URL(decoded, base).href : decoded;
    } catch {
      return decoded;
    }
  };

  const note = (name: string) => {
    if (!trackers.includes(name)) trackers.push(name);
  };

  /** A resource URL as it should load: removed for trackers, inlined for cid:, else unchanged. */
  const resource = (url: string, attribute = false): string => {
    const decodedCss = attribute ? url : decodeCssEscapes(url);
    const trimmed = absolute(decodedCss, attribute).trim();
    if (/^cid:/i.test(trimmed)) {
      hasCid = true;
      try {
        const id = stripMessageIdBrackets(decodeURIComponent(trimmed.slice(4)));
        return options.inline?.[id] ?? url;
      } catch {
        return url;
      }
    }
    const tracker = trackerFor(trimmed);
    if (tracker) {
      note(tracker);
      return EMPTY;
    }
    let next = trimmed;
    if (isRemote(trimmed)) {
      hasRemote = true;
      // The app has a secure origin. Opted-in resources use HTTPS rather than
      // relying on Chromium's mixed-content exceptions for HTTP images.
      try {
        const remote = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
        remote.protocol = "https:";
        next = remote.href;
      } catch {
        return url;
      }
    }
    if (next === (attribute ? attributeText(url) : url)) return url;
    return attribute ? attributeUrl(next) : next;
  };

  const css = (text: string, attribute = false) => {
    const source = attribute ? attributeText(text) : text;
    const imported = source.replace(
      /(@import\s+)(['"])(.*?)\2/gi,
      (_whole, prefix: string, quote: string, url: string) =>
        `${prefix}${quote}${resource(url)}${quote}`,
    );
    const result = rewriteImageSets(imported, resource).replace(
      CSS_URL,
      (whole, quote: string, url: string) => {
        const next = resource(url);
        if (next === url) return whole;
        const quoted = quote || (/['"()\s]/u.test(next) ? '"' : "");
        const escaped = quoted
          ? next.replaceAll("\\", "\\\\").replaceAll(quoted, `\\${quoted}`)
          : next;
        return `url(${quoted}${escaped}${quoted})`;
      },
    );
    if (source === result) return text;
    return attribute ? attributeUrl(result) : result;
  };

  const srcset = (value: string) =>
    value
      .split(",")
      .map((candidate) => candidate.trim())
      .flatMap((candidate) => {
        const match = /^(\S+)(.*)$/.exec(candidate);
        const url = match?.[1] ?? "";
        const next = resource(url, true);
        return next === EMPTY ? [] : [`${next}${match?.[2] ?? ""}`];
      })
      .join(", ");

  const rewriteTag = (whole: string, name: string, attrs: string, selfClose: string) => {
    const tag = name.toLowerCase();
    if (tag === "base") return "";
    const parsed: [string, string | undefined][] = [];
    for (const m of attrs.matchAll(ATTR)) {
      parsed.push([m[1] ?? "", m[2] === undefined ? undefined : unquote(m[2])]);
    }
    const get = (key: string) => parsed.find(([k]) => k.toLowerCase() === key)?.[1];

    if (
      tag === "link" &&
      attributeText(get("rel") ?? "")
        .trim()
        .toLowerCase() !== "stylesheet"
    )
      return "";

    // Tracker images go away whole, so no broken-image icon is left behind.
    // An image of one pixel or less from an unlisted remote host is an open
    // pixel too. Parsers read <image> outside SVG as <img> (htmlparser2 12 does).
    if (tag === "img" || tag === "image") {
      const src = absolute(get("src") ?? "", true);
      const tracker = trackerFor(src);
      if (tracker) {
        note(tracker);
        return "";
      }
      const style = get("style");
      const width = get("width") ?? styleDimension(style, "width");
      const height = get("height") ?? styleDimension(style, "height");
      if (isRemote(src) && tiny(width) && tiny(height)) {
        pixels++;
        return "";
      }
    }

    const out = parsed.map(([key, value]): [string, string | undefined] => {
      if (value === undefined) return [key, value];
      const k = key.toLowerCase();
      let next = value;
      if (RESOURCE_ATTRS.has(k)) next = resource(value, true);
      else if (k === "srcset") next = srcset(value);
      else if (k === "style") next = css(value, true);
      else if ((k === "href" || k === "xlink:href") && (tag === "link" || tag === "image"))
        next = resource(value, true);
      else if ((k === "href" || k === "xlink:href") && base)
        next = attributeUrl(absolute(value, true));
      return [key, next];
    });
    if (out.every(([, value], i) => value === parsed[i]?.[1])) return whole;
    const rebuilt = out
      .map(([key, value]) =>
        value === undefined ? key : `${key}="${value.replaceAll('"', "&quot;")}"`,
      )
      .join(" ");
    return `<${name} ${rebuilt}${selfClose ? " /" : ""}>`;
  };

  const withStyles = html.replace(
    STYLE_BLOCK,
    (_whole, open: string, body: string, close: string) => `${open}${css(body)}${close}`,
  );
  const result = withStyles.replace(TAG, rewriteTag);
  return { html: result, trackers, pixels, hasRemote, hasCid };
}
