/**
 * Regression for tracker-stripping bypasses: markup the old regex tokenizer
 * skipped, URLs a browser normalizes into a tracker URL, and fractional open
 * pixels. The leak check reparses the output with parse5, as a browser would,
 * and reads every URL-bearing attribute and CSS value independently of the
 * product's own tracker matcher.
 */
import * as fc from "fast-check";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it } from "vitest";
import { parse as parseCss, walk } from "./css-tree-browser.js";
import { prepareMessageHtml } from "./reader-html.js";
import {
  READER_VIEWPORT_HEIGHT,
  sanitizeReaderCss,
  sanitizeReaderHtml,
} from "./reader-sanitize.js";
import { srcsetCandidates } from "./resource-url.js";
import { trackerFor } from "./trackers.js";

const T = "https://mandrillapp.com/track/open.php?u=1";
const PIXEL = "https://unlisted.example/p.gif";

/** The judge's payloads (t2.mjs and t3.mjs), minus one that names a tracker only in another host's query. */
const JUDGE = [
  `<img src="${T}">`,
  `<IMG\nSRC="${T}">`,
  `<img\tsrc='${T}'>`,
  `<img src=${T}>`,
  `<img/src="${T}">`,
  `<img alt=">" src="${T}">`,
  `<img src="HTTPS://MANDRILLAPP.COM/track/open.php">`,
  `<img src="https://x.mandrillapp.com./track/open.php">`,
  `<img src="https://mandrillapp.com:443/track/open.php">`,
  `<img src="https://MandrillApp.com/%74rack/open">`,
  `<img src="https://mandrillapp.com/track/%6fpen">`,
  `<img src="https://mandrillapp.com\\@evil/track/open">`,
  `<img src="&#104;ttps://mandrillapp.com/track/open">`,
  `<img src="https://mandrillapp.com/track/open" srcset="${T} 1x">`,
  `<div style="background:url(${T})">`,
  `<div style="background:url(&quot;${T}&quot;)">`,
  `<div style="background:URL( ${T} )">`,
  `<div style="background:\\75 rl(${T})">`,
  `<style>div{background:url(${T})}</style>`,
  `<style>@import "${T}";</style>`,
  `<table background="${T}">`,
  `<body background="${T}">`,
  `<img src="//mandrillapp.com/track/open">`,
  `<img src="http://mandrillapp.com/track/open">`,
  `<img data-x=1 src = "${T}" >`,
  `<img src="https://mandrillapp.com/track/open"\nwidth=1>`,
  `<img width=1 height=1 src="${PIXEL}">`,
  `<img src="${PIXEL}" style="width:1px;height:1px">`,
  `<img src="${PIXEL}" width="1" height="0.5">`,
  `<img src="${PIXEL}" style="width:0.1px;height:1px">`,
  `<div style="background:url(${T.replace("mandrillapp.com", "mandrillapp.com.")})">`,
  `<div style="background:image-set('${T}' 1x)">`,
  `<img src="https://mandrillapp.com/track/open" ></img>`,
  `<a><img src="${T}"/></a>`,
  `<img src="https://u:p@mandrillapp.com/track/open">`,
  `<img "src="${T}">`,
  `<img a=b/src="${T}">`,
  `<img src="${T}"\u000c>`,
  `<img src="${T}" alt="a>b">`,
  `<img src=\u0000"${T}">`,
  `<img src="${T}"/>`,
  `<img src="${T}" / onerror=1>`,
  `<img src="${T}"<b>`,
  `<img\u000csrc="${T}">`,
  `<img src=\`${T}\`>`,
  `<img src="${T}"=x>`,
  `<img src="${T}"x>`,
  `<img src="${T}"/ >`,
  `<img data-a="1" src="${T}" data-b>`,
  `<img src=${T} width=1>`,
  `<img src="  ${T}">`,
  `<img src="\n${T}">`,
  `<img src="ht\ntps://mandrillapp.com/track/open">`,
  `<div style="background:url(${T})\u000c">`,
  `<div style='background:url("${T}")'>`,
  `<div style=background:url(${T})>`,
  `<div style="background:url(${T});">`,
  `<style media="x">div{background:url(${T})}</style >`,
  `<STYLE>div{background:url(${T})}</STYLE>`,
  `<style\n>div{background:url(${T})}</style\n>`,
  `<style>/**/div{background:url(${T})}</style>`,
  `<div style="background:url(/*x*/${T})">`,
  `<div style="background:url(${T.replace("https:", "https&colon;")})">`,
  `<img src="${T}" id=a/>`,
  `<div style="background:url(https://x.mandrillapp.com./track/open.php)">`,
];

/** Variants beyond the judge's list. */
const VARIANTS = [
  `<iMg SrC="hTtPs://MaNdRiLlApP.cOm/TrAcK/oPeN">`,
  `<img src="https:&#x2f;&#x2f;mandrillapp.com&#x2f;track&#x2f;open">`,
  `<img src="https&#58;//mandrillapp&#46;com/track/open">`,
  `<img src="//MANDRILLAPP.COM./track/open">`,
  `<img src="\\\\mandrillapp.com/track/open">`,
  `<img src="https:mandrillapp.com/track/open">`,
  `<img src="https:/\\mandrillapp.com/track/open">`,
  `<img src="https://mandrillapp.com/x/../track/open">`,
  `<img src="https://mandrillapp.com/x/%2e%2e/track/open">`,
  `<img src="https://mandrillapp.com/x%2f..%2ftrack/open">`,
  `<img src="https://mandrillapp.com/%2574rack/open">`,
  `<img src="https://%6dandrillapp.com/track/open">`,
  `<img src="https://ｍandrillapp.com/track/open">`,
  `<img src="https://mandrillapp.com/track\\open">`,
  `<img src="ht\ttps://mandril\nlapp.com/tra\rck/open">`,
  `<img src="\u0001https://mandrillapp.com/track/open\u0002">`,
  `<img srcset="https://cdn.example/a.png 1x, ${T} 2x, https://cdn.example/c.png 3x">`,
  `<img srcset="${T},https://cdn.example/b.png 2x">`,
  `<picture><source srcset="${T} 1x, https://cdn.example/b.png 2x"><img src="${T}"></picture>`,
  `<picture><source srcset="${T}"><img src="https://cdn.example/b.png"></picture>`,
  `<svg><image href="${T}"/></svg>`,
  `<svg><image xlink:href="${T}"></image></svg>`,
  `<svg><use href="${T}#a"/></svg>`,
  `<image src="${T}">`,
  `<input type=image src="${T}">`,
  `<video poster="${T}"></video>`,
  `<td background="//mandrillapp.com/track/open">`,
  `<div style="background:url('//mandrillapp.com/track/open')">`,
  `<div style="background:url(https://mandrillapp.com/%74rack/open)">`,
  `<div style="background:url(https://mandrillapp.com/tr\\61 ck/open)">`,
  `<div style="--x:url(${T});background:var(--x)">`,
  `<div style="list-style-image:url(${T})">`,
  `<div style="cursor:url(${T}),auto">`,
  `<div style="background:-webkit-image-set(url(${T}) 1x)">`,
  `<div style="background:image-set('${T}' 1x, '${T}' 2x)">`,
  `<div style="content:attr(title url)" title="${T}">`,
  `<div style="background:src('${T}')">`,
  `<style>@import url(${T});</style>`,
  `<style>@media all{div{background:url(${T})}}</style>`,
  `<style>div{background:url(${T}</style>`,
  `<base href="https://mandrillapp.com/"><img src="track/open">`,
  `<base href="https://mandrillapp.com/x/"><div style="background:url(../track/open)">`,
  `<img src="${PIXEL}" width="0">`,
  `<img src="${PIXEL}" height="1.9">`,
  `<img src="${PIXEL}" width=".5" height="100">`,
  `<img src="${PIXEL}" style="height:0">`,
  `<img src="${PIXEL}" style="width:1PX!important">`,
  `<img src="${PIXEL}" style="max-height:1px">`,
  `<img src="${PIXEL}" style="width:0.01em">`,
  `<img src="${PIXEL}" style="width:1pt">`,
  `<img src="${PIXEL}" style="w\\69 dth:1px">`,
  `<img src="//unlisted.example/p.gif" width=1>`,
  `<image src="${PIXEL}" height=1>`,
];

const PAYLOADS = [...JUDGE, ...VARIANTS];

/** Whether the browser would request a tracker or the unlisted pixel for this URL text. */
function loadsTracker(value: string): boolean {
  const text = value.replace(/[\t\n\r]/g, "").trim();
  let url: URL;
  try {
    url = new URL(/^[\\/]{2}/.test(text) ? `https:${text}` : text);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.replace(/\.+$/, "");
  let path = url.pathname;
  try {
    path = decodeURIComponent(decodeURIComponent(path));
  } catch {
    /* keep the encoded path */
  }
  path = new URL(path.replaceAll("\\", "/"), "https://x.invalid").pathname;
  if (host === "unlisted.example") return true;
  if (host === "pstmrk.it" || host.endsWith(".pstmrk.it")) return true;
  return (
    (host === "mandrillapp.com" || host.endsWith(".mandrillapp.com")) && /track\/open/i.test(path)
  );
}

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** URL values in CSS text: every url() and every string, read by css-tree. */
function cssUrls(css: string, inline: boolean): string[] {
  const urls: string[] = [];
  try {
    walk(parseCss(css, { context: inline ? "declarationList" : "stylesheet" }), (node) => {
      if (node.type === "Url" || node.type === "String") urls.push(node.value);
      if (node.type === "Raw") urls.push(...(node.value.match(/https?:[^\s)'"]+/gi) ?? []));
    });
  } catch {
    urls.push(css);
  }
  return urls;
}

/** Loadable tracker URLs in HTML, after a browser-grade reparse. */
function leaks(html: string): string[] {
  const found: string[] = [];
  const visit = (parent: ParentNode) => {
    for (const child of parent.childNodes) {
      if (!("tagName" in child)) continue;
      const element: Element = child;
      const values: string[] = [];
      for (const { name, value } of element.attrs) {
        if (["src", "background", "poster", "data", "lowsrc", "dynsrc"].includes(name))
          values.push(value);
        else if (["srcset", "imagesrcset"].includes(name))
          values.push(...srcsetCandidates(value).map((c) => c.url), ...value.split(/[\s,]+/));
        else if (["href", "xlink:href"].includes(name) && element.tagName !== "a")
          values.push(value);
        else if (name === "style") values.push(...cssUrls(value, true));
      }
      if (element.tagName === "style")
        for (const text of element.childNodes)
          if ("value" in text) values.push(...cssUrls(text.value, false));
      for (const value of values) if (loadsTracker(value)) found.push(value);
      visit(element);
    }
  };
  visit(parseHtml(html));
  return found;
}

const render = (html: string, remote: boolean) =>
  sanitizeReaderHtml(prepareMessageHtml(html).html, remote, undefined, READER_VIEWPORT_HEIGHT);

describe("tracker bypass payloads", () => {
  it("the leak check sees an unprotected tracker", () => {
    for (const payload of [
      `<img src="${T}">`,
      `<img src="ht\ntps://mandrillapp.com/track/open">`,
      `<div style="background:url(https://x.mandrillapp.com./track/open.php)">`,
      `<img srcset="https://cdn.example/a 1x, ${T} 2x">`,
      `<img src="${PIXEL}" width=1>`,
    ])
      expect(leaks(payload), payload).not.toEqual([]);
  });

  for (const remote of [true, false])
    it(`leave no loadable tracker with remote images ${remote ? "on" : "off"}`, () => {
      for (const payload of PAYLOADS) {
        expect(leaks(render(payload, remote)), payload).toEqual([]);
        // The sanitizer is the last gate and holds on its own.
        expect(leaks(sanitizeReaderHtml(payload, remote)), payload).toEqual([]);
      }
    });

  it("prepareMessageHtml reports the tracker or pixel for markup-level payloads", () => {
    for (const payload of PAYLOADS) {
      // Only payloads whose own image element loads a tracker, as a browser parses them.
      if (!/^<(img|image|input|svg)\b/i.test(payload) || payload.includes("srcset")) continue;
      if (!leaks(payload).length) continue;
      const prepared = prepareMessageHtml(payload);
      expect(prepared.trackers.length + prepared.pixels, payload).toBe(1);
    }
  });

  it("keeps ordinary images, including large ones with small attributes elsewhere", () => {
    const html =
      '<img src="https://cdn.example/hero.png" width="600" height="200">' +
      '<img src="https://cdn.example/logo.png" style="width:120px">' +
      '<img src="https://cdn.example/b.png" width="50%">' +
      '<a href="https://mandrillapp.com/track/click?u=1">Read</a>';
    const out = render(html, true);
    expect(out).toContain('src="https://cdn.example/hero.png"');
    expect(out).toContain('src="https://cdn.example/logo.png"');
    expect(out).toContain('src="https://cdn.example/b.png"');
    expect(out).toContain('href="https://mandrillapp.com/track/click?u=1"');
  });
});

describe("tracker URL normalization", () => {
  it("matches the URL a browser loads", () => {
    for (const url of [
      "ht\ntps://mandrillapp.com/track/open",
      "https://x.mandrillapp.com./track/open.php",
      "https://mandrillapp.com/%74rack/open",
      "https://mandrillapp.com/track/%6fpen",
      "https://mandrillapp.com/x%2f..%2ftrack/open",
      "https:mandrillapp.com/track/open",
      "//MANDRILLAPP.COM/track/open",
      "https://ｍandrillapp.com/track/open",
    ])
      expect(trackerFor(url), url).toBe("Mandrill");
    expect(trackerFor("https://evil.example/?https://mandrillapp.com/track/open")).toBe(undefined);
    expect(trackerFor("https://mandrillapp.com/track/click")).toBe(undefined);
  });

  it("turns attr() with a URL type and src() into none", () => {
    for (const css of [
      "content:attr(title url)",
      "background:attr(data-x type(<url>))",
      'background:src("https://example.test/x")',
      "background:SRC('https://example.test/x')",
    ])
      expect(sanitizeReaderCss(css, true, true), css).not.toMatch(/attr|src\(|example\.test/i);
    expect(sanitizeReaderCss("content:attr(title)", true, true)).toBe("content:attr(title)");
  });
});

describe("tracker bypass properties", () => {
  const options = {
    seed: 0x7a11,
    numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 60 : 400,
  };
  const withControl = (text: string, at: number, character: string) => {
    const i = at % (text.length + 1);
    return text.slice(0, i) + character + text.slice(i);
  };
  const entity = (text: string, picks: number[]) =>
    text
      .split("")
      .map((character, i) =>
        picks.includes(i) ? `&#x${character.charCodeAt(0).toString(16)};` : character,
      )
      .join("");
  const percent = (text: string, picks: number[]) =>
    text
      .split("")
      .map((character, i) =>
        picks.includes(i) && /[a-z]/i.test(character)
          ? `%${character.charCodeAt(0).toString(16)}`
          : character,
      )
      .join("");
  const caseMix = (text: string, mask: number) =>
    text
      .split("")
      .map((character, i) => ((mask >> (i % 30)) & 1 ? character.toUpperCase() : character))
      .join("");

  const trackerUrl = fc
    .record({
      scheme: fc.constantFrom("https://", "http://", "//", "HTTPS://", "https:", "https:/\\"),
      sub: fc.constantFrom("", "x.", "a.b."),
      host: fc.constantFrom("mandrillapp.com", "pstmrk.it"),
      dot: fc.boolean(),
      port: fc.constantFrom("", ":443", ":80"),
      prefix: fc.constantFrom("", "/x/..", "/./", "/x/%2e%2e"),
      pathPicks: fc.array(fc.nat(9), { maxLength: 3 }),
      mask: fc.nat(),
      control: fc.option(fc.tuple(fc.nat(), fc.constantFrom("\n", "\t", "\r")), { nil: undefined }),
    })
    .map(({ scheme, sub, host, dot, port, prefix, pathPicks, mask, control }) => {
      const url = `${scheme}${caseMix(`${sub}${host}`, mask)}${dot ? "." : ""}${port}${prefix}/${percent("track/open", pathPicks)}?u=1`;
      return control ? withControl(url, control[0], control[1]) : url;
    });

  const markup = fc
    .record({
      url: trackerUrl,
      entityPicks: fc.array(fc.nat(40), { maxLength: 4 }),
      separator: fc.constantFrom(" ", "/", "\n", "\t", "\f", " / "),
      quote: fc.constantFrom('"', "'", ""),
      junk: fc.constantFrom("", "x", "/ ", "<b", "=x", '"', " / onerror=1", "\f"),
      tag: fc.constantFrom("img", "IMG", "image", "Img"),
      place: fc.nat(13),
    })
    .map(({ url, entityPicks, separator, quote, junk, tag, place }) => {
      const value = entity(url, entityPicks);
      const attr = (name: string) =>
        `${name}=${quote}${quote ? value : value.replace(/[\s>]/g, "")}${quote}${junk}`;
      switch (place) {
        case 0:
          return `<${tag}${separator}${attr("src")}>`;
        case 1:
          return `<img srcset="https://cdn.example/a.png 1x, ${value} 2x">`;
        case 2:
          return `<picture><source srcset="${value}"><img src="https://cdn.example/a.png"></picture>`;
        case 3:
          return `<svg><image ${attr("href")}/></svg>`;
        case 4:
          return `<input type=image ${attr("src")}>`;
        case 5:
          return `<table${separator}${attr("background")}><tr><td>x</td></tr></table>`;
        case 6:
          return `<video ${attr("poster")}></video>`;
        case 7:
          return `<div style="background:url(${value.replaceAll('"', "")})">x</div>`;
        case 8:
          return `<div style='background-image:url("${value.replaceAll("'", "")}")'>x</div>`;
        case 9:
          return `<style>p{background:url(${url})}</style><p>x</p>`;
        case 10:
          return `<style>p{background:image-set("${url}" 1x)}</style><p>x</p>`;
        case 11:
          return `<svg><image xlink:href="${value}"></image></svg>`;
        case 12:
          return `<td background="${value}">x</td>`;
        default:
          return `<body ${attr("background")}>x</body>`;
      }
    });

  it("no generated tracker variant survives either remote-image setting", () => {
    fc.assert(
      fc.property(markup, (html) => {
        for (const remote of [true, false]) expect(leaks(render(html, remote)), html).toEqual([]);
      }),
      options,
    );
  });

  const pixel = fc
    .record({
      width: fc.option(fc.double({ min: 0, max: 1.99, noNaN: true }), { nil: undefined }),
      height: fc.option(fc.double({ min: 0, max: 400, noNaN: true }), { nil: undefined }),
      inline: fc.boolean(),
      unit: fc.constantFrom("px", "", "PX"),
    })
    .filter(({ width }) => width !== undefined)
    .map(({ width, height, inline, unit }) => {
      const w = Number(width?.toFixed(3));
      const h = height === undefined ? undefined : Number(height.toFixed(1));
      return inline
        ? `<img src="${PIXEL}" style="width:${w}${unit || "px"}${h === undefined ? "" : `;height:${h}px`}">`
        : `<img src="${PIXEL}" width="${w}${unit}"${h === undefined ? "" : ` height="${h}"`}>`;
    });

  it("any image under 2 px wide is a pixel, from attributes or inline CSS", () => {
    fc.assert(
      fc.property(pixel, (html) => {
        expect(prepareMessageHtml(html).pixels, html).toBe(1);
        for (const remote of [true, false]) expect(leaks(render(html, remote)), html).toEqual([]);
      }),
      options,
    );
  });
});
