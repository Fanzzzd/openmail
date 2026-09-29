/**
 * Prepares untrusted mail HTML for the reader and for printing. It only
 * rewrites resource URLs; the sandboxed iframe and its CSP stay the security
 * boundary. No Node dependencies; exported through `@openmail/core/schema`.
 */
import { trackerFor } from "./trackers.js";

export interface PreparedHtml {
  html: string;
  /** Tracking services whose URLs were removed, each once. */
  trackers: string[];
  /** 1×1 remote images from hosts not on the list, removed as likely open pixels. */
  pixels: number;
  /** Remote images or styles are left that the CSP blocks until images are allowed. */
  hasRemote: boolean;
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

export function prepareMessageHtml(html: string, options: PrepareOptions = {}): PreparedHtml {
  const trackers: string[] = [];
  let pixels = 0;
  let hasRemote = false;

  const note = (name: string) => {
    if (!trackers.includes(name)) trackers.push(name);
  };

  /** A resource URL as it should load: removed for trackers, inlined for cid:, else unchanged. */
  const resource = (url: string): string => {
    const trimmed = url.trim();
    if (/^cid:/i.test(trimmed)) {
      const id = decodeURIComponent(trimmed.slice(4)).replace(/^<|>$/g, "");
      return options.inline?.[id] ?? url;
    }
    const tracker = trackerFor(trimmed);
    if (tracker) {
      note(tracker);
      return EMPTY;
    }
    if (isRemote(trimmed)) hasRemote = true;
    return url;
  };

  const css = (text: string) =>
    text.replace(CSS_URL, (whole, quote: string, url: string) => {
      const next = resource(url);
      return next === url ? whole : `url(${quote}${next}${quote})`;
    });

  const srcset = (value: string) =>
    value
      .split(",")
      .map((candidate) => candidate.trim())
      .filter((candidate) => {
        const url = candidate.split(/\s+/)[0] ?? "";
        return resource(url) === url;
      })
      .join(", ");

  const rewriteTag = (whole: string, name: string, attrs: string, selfClose: string) => {
    const tag = name.toLowerCase();
    const parsed: [string, string | undefined][] = [];
    for (const m of attrs.matchAll(ATTR)) {
      parsed.push([m[1] ?? "", m[2] === undefined ? undefined : unquote(m[2])]);
    }
    const get = (key: string) => parsed.find(([k]) => k.toLowerCase() === key)?.[1];

    // Tracker images go away whole, so no broken-image icon is left behind.
    // An image of one pixel or less from an unlisted remote host is an open
    // pixel too.
    if (tag === "img") {
      const src = get("src") ?? "";
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
      if (RESOURCE_ATTRS.has(k)) next = resource(value);
      else if (k === "srcset") next = srcset(value);
      else if (k === "style") next = css(value);
      else if (k === "href" && tag === "link") next = resource(value);
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
  return { html: result, trackers, pixels, hasRemote };
}
