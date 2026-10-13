import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Prefs } from "@openmail/core/schema";
import { expect, it } from "vitest";
import { fakeMessage, runElectron, serveWebApp, webRoot } from "./test-support/web-app-harness";

/**
 * The reader's message frame in real Chromium: synthetic mail opened in the
 * built web app (turbo builds it first), whose reader is the desktop reader.
 * Each frame must end exactly as tall as its page, draw at most two heights per
 * change, hold still afterwards and never scroll sideways into blank space. A
 * find hit must end inside the pane, with the frame not scrolled inside.
 */
const driver = path.join(import.meta.dirname, "reader-frame-driver.cjs");

interface Case {
  name: string;
  html: string;
  pane?: number;
  steps?: (
    | "viewAt100"
    | "showQuotes"
    | "growImage"
    | "find"
    | "findNext"
    | "findPrevious"
    | "search"
  )[];
  /** The word the find step types. */
  find?: string;
  /** The words the search step types; the message's text must contain them. */
  search?: string;
  group?: "dark" | "zoom";
  /** The thread's earlier message, whose text this one quotes. */
  quotes?: string;
}

const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const wide = (marker: string) =>
  `<p>${marker}: the table below is 742 px wide.</p><table cellpadding="0" cellspacing="0"><tr><td>` +
  `<div style="width:742px;height:300px;background:#fde">Wide newsletter column</div></td></tr></table>` +
  `<p>${"Text after the table. ".repeat(20)}</p>`;
const newsletter = (marker: string) =>
  `<table width="100%"><tr><td><h1>${marker}</h1>${Array.from(
    { length: 40 },
    (_, i) =>
      `<p>Story ${i}: ${"Lorem ipsum dolor sit amet, consectetur adipiscing. ".repeat(4)}</p>`,
  ).join("")}</td></tr></table>`;
const QUOTED = "The quarterly numbers are attached and the review is on Thursday at noon. "
  .repeat(12)
  .trim();

// A quote far taller than the pane, with the only find hits deep inside it.
const LONG_QUOTED = Array.from(
  { length: 400 },
  (_, i) =>
    `Line ${i} of the long quoted report${i === 160 || i === 340 ? " zebrafind" : ""} goes here.`,
).join(" ");

const CASES: Case[] = [
  { name: "plain", html: "<p>plain: a short note.</p>" },
  { name: "newsletter", html: newsletter("newsletter") },
  { name: "fit", html: wide("fit"), pane: 480 },
  { name: "view100", html: wide("view100"), pane: 480, steps: ["viewAt100"] },
  { name: "pct", html: "<style>html,body{height:100%} body{padding:20px}</style><p>pct body</p>" },
  {
    name: "minvh",
    html: "<style>body{min-height:100vh;padding-bottom:10px}</style><p>minvh body</p>",
  },
  { name: "vh100", html: '<div style="height:100vh;background:#eef">vh100 box</div><p>after</p>' },
  { name: "vh110", html: '<div style="height:110vh;background:#eef">vh110 box</div><p>after</p>' },
  {
    name: "fixedwrap",
    html: '<div style="height:100px"><div style="height:500px;background:#eee">fixedwrap</div></div>',
  },
  {
    name: "absolute",
    html: '<p>absolute</p><div style="position:absolute;top:400px;height:50px;width:40px;background:#c33"></div>',
  },
  {
    name: "negmargin",
    html: '<div style="height:340px;margin-bottom:-30px;background:#eee">negmargin</div>',
  },
  {
    name: "growimage",
    html: `<p>growimage</p><img id="grow" width="100" src="${GIF}"><p>below the image</p>`,
    steps: ["growImage"],
  },
  {
    name: "quotes",
    html: `<p>quotes: see you there.</p><div class="gmail_quote"><p>On Monday Dana wrote:</p><blockquote>${QUOTED}</blockquote></div>`,
    steps: ["showQuotes"],
    quotes: QUOTED,
  },
  {
    name: "findquote",
    html: `<p>findquote: replying below.</p><div class="gmail_quote"><p>On Monday Dana wrote:</p><blockquote>${LONG_QUOTED}</blockquote></div>`,
    steps: ["find", "findNext", "findPrevious"],
    find: "zebrafind",
    quotes: LONG_QUOTED,
  },
  { name: "ownzoom", html: `<style>html{zoom:1.5}</style>${newsletter("ownzoom")}` },
  {
    name: "heightquery",
    html: '<style>@media (min-height:100px){p{margin-top:200px}}</style><div style="height:150px">heightquery</div><p>after</p>',
  },
  {
    // Mail CSS that would react to an added element: the outline must never appear.
    // Last in its group: the search leaves the list filtered.
    name: "highlightdom",
    html: `<style>body:has(mark), body:has([class]), p:has(> :not(b)) { outline: 3px solid red; }</style><p>highlightdom: <b>zebrafind</b> and zebrafind again.</p>`,
    steps: ["search", "find", "findNext"],
    search: "highlightdom",
    find: "zebrafind",
  },
  { name: "dark", html: wide("dark") + newsletter("dark news"), group: "dark" },
  { name: "zoom150", html: wide("zoom150") + newsletter("zoom news"), group: "zoom" },
];

const GROUPS: { group: Case["group"]; prefs: Partial<Prefs>; dark: boolean }[] = [
  { group: undefined, prefs: {}, dark: false },
  { group: "dark", prefs: { messageBackground: "theme" }, dark: true },
  { group: "zoom", prefs: { readerZoom: 150 }, dark: false },
];

interface Result {
  name: string;
  pane: number;
  settled: number;
  heights: { phase: number; t: number; h: number }[];
  frame: number;
  extent: number;
  right: number;
  clientWidth: number;
  bar: number;
  reach: number;
  paneReach: number;
  zoom: string;
  wideButton: boolean;
  /** After each find step: the current hit's top and bottom in the pane, and the frame's own scroll. */
  hits: { step: string; top: number; bottom: number; pane: number; frameScroll: number }[];
  /** After each step of a find case: whether the mail's document is unchanged, the highlight sizes, and the probe's outline. */
  dom: { step: string; same: boolean; highlights: Record<string, number>; probe: string }[];
}

const subject = (name: string) => `Frame case ${name}`;

// Skips without `pnpm build`, except under CI, where a missing web build fails.
it.skipIf(!process.env.CI && !existsSync(path.join(webRoot, "web.html")))(
  "sizes each message frame to its page in Chromium",
  { timeout: 300_000 },
  async () => {
    const messages = CASES.map((c, index) =>
      fakeMessage(String(index + 1), subject(c.name), "Frame Lab", index + 1, {
        bodyHtml: c.html,
        bodyText: c.name,
      }),
    );
    // A quoting case's thread: the message it quotes comes first.
    for (const [index, c] of CASES.entries()) {
      const quoting = messages[index];
      if (!c.quotes || !quoting) continue;
      messages.push(
        fakeMessage(`${index + 1}0`, subject(c.name), "Dana Whitfield", 600 + index, {
          threadId: quoting.threadId,
          bodyText: c.quotes,
          bodyHtml: `<p>${c.quotes}</p>`,
        }),
      );
    }
    const app = await serveWebApp(messages);
    const work = mkdtempSync(path.join(tmpdir(), "openmail-reader-frame-"));
    const results: Result[] = [];
    try {
      for (const { group, prefs, dark } of GROUPS) {
        await app.setPrefs({ messageBackground: "light", readerZoom: 100, ...prefs });
        const cases = CASES.filter((c) => c.group === group).map((c) => ({
          name: c.name,
          subject: subject(c.name),
          marker: c.name,
          pane: c.pane ?? 600,
          steps: c.steps ?? [],
          find: c.find,
          search: c.search,
        }));
        const config = path.join(work, "config.json");
        const out = path.join(work, "out.json");
        writeFileSync(
          config,
          JSON.stringify({
            url: app.url,
            dark,
            cases,
            // Opened before each case, so its frame is created while recording.
            others: [subject("plain"), subject("newsletter")],
          }),
        );
        expect(await runElectron(driver, [config, out], work)).toBe(0);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON written by the driver
        results.push(...(JSON.parse(readFileSync(out, "utf8")) as Result[]));
      }
    } finally {
      await app.close();
      rmSync(work, { recursive: true, force: true });
    }

    const problems: string[] = [];
    for (const r of results) {
      const expected = Math.ceil(r.extent) + r.bar;
      if (Math.abs(r.frame - expected) > 1)
        problems.push(`${r.name}: frame ${r.frame}px, page ${expected}px`);
      // Sideways scroll reveals only content: nothing past the page's right edge.
      const overflow = Math.max(0, Math.ceil(r.right) - r.clientWidth);
      if (r.reach > overflow + 1)
        problems.push(`${r.name}: scrolls ${r.reach}px sideways, content ${overflow}px`);
      if (r.paneReach > 0) problems.push(`${r.name}: thread pane scrolls ${r.paneReach}px`);
      // Per phase (load, then each step): at most two heights after the first.
      for (const phase of new Set(r.heights.map((h) => h.phase))) {
        const drawn = r.heights.filter((h) => h.phase === phase).map((h) => h.h);
        const changes = drawn.filter((h, i) => i > 0 && h !== drawn[i - 1]).length;
        if (changes > 2)
          problems.push(`${r.name}: ${changes} heights in phase ${phase}: ${drawn.join(",")}`);
      }
      // Each find step ends with its hit inside the pane, the frame unscrolled.
      for (const hit of r.hits)
        if (hit.top < 0 || hit.bottom > hit.pane || hit.frameScroll !== 0)
          problems.push(
            `${r.name}: ${hit.step} hit at ${Math.round(hit.top)}-${Math.round(hit.bottom)}px in a ${hit.pane}px pane, frame scrolled ${hit.frameScroll}px`,
          );
      const late = r.heights.filter((h) => h.t > r.settled).map((h) => h.h);
      if (late.length) problems.push(`${r.name}: still changing after settling: ${late.join(",")}`);
    }
    const fit = results.find((r) => r.name === "fit");
    expect(fit?.wideButton).toBe(true);
    expect(fit?.zoom).not.toBe("");
    expect(fit?.pane).toBe(480);
    const view100 = results.find((r) => r.name === "view100");
    expect(view100?.zoom).toBe("");
    expect(view100?.reach).toBeGreaterThan(200);
    expect(results.find((r) => r.name === "findquote")?.hits).toHaveLength(3);
    // Search and find draw highlights; the mail's document gains no element, class or attribute.
    for (const r of results)
      for (const step of r.dom)
        if (!step.same || step.probe !== "none")
          problems.push(`${r.name}: ${step.step} changed the mail's document`);
    const highlighted = results.find((r) => r.name === "highlightdom")?.dom;
    expect(highlighted?.map((step) => step.step)).toEqual(["search", "find", "findNext"]);
    // The search word appears once, so it is the current hit.
    expect(highlighted?.[0]?.highlights["openmail-search-active"]).toBe(1);
    expect(highlighted?.[2]?.highlights["openmail-find-hit"]).toBe(2);
    expect(highlighted?.[2]?.highlights["openmail-find-active"]).toBe(1);
    // The height query holds at the reader's 800 px viewport, so its margin applies.
    expect(results.find((r) => r.name === "heightquery")?.frame).toBeGreaterThan(350);
    expect(problems).toEqual([]);
  },
);
