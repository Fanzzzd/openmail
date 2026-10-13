import * as fc from "fast-check";
import { expect, it } from "vitest";
import { parseCalendar } from "./invites.js";
import { structuredMailEvents } from "./structured-events.js";
import { escapeHtml, stripActiveContent } from "../reader/print.js";
import { scaledMs } from "../../test-support/test-time.js";

const options = {
  seed: 0x520065,
  numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 30 : 150,
};
const dates = fc
  .tuple(
    fc.integer({ min: 1970, max: 2099 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(
    ([year, month, day]) =>
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );
const icsText = (text: string) =>
  text
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");

it("generated RFC 5545 events keep escaped summaries and valid floating dates", () => {
  fc.assert(
    fc.property(dates, fc.string({ unit: "grapheme", maxLength: 80 }), (date, summary) => {
      const day = date.replaceAll("-", "");
      const source = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:fuzz@example.test\r\nDTSTART:${day}T120000\r\nDTEND:${day}T130000\r\nSUMMARY:${icsText(summary)}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
      const invite = parseCalendar(source)[0]?.invite;
      expect(invite?.title).toBe(summary.replace(/\r\n|\r/g, "\n"));
      expect(invite?.start).toEqual({ kind: "floating", value: `${date}T12:00:00` });
      expect(invite?.end).toEqual({ kind: "floating", value: `${date}T13:00:00` });
    }),
    options,
  );
});

it("generated JSON-LD and microdata event dates agree without fetching contexts", () => {
  fc.assert(
    fc.property(dates, fc.string({ unit: "grapheme", maxLength: 80 }), (date, title) => {
      const event = {
        "@context": "https://evil.test/context",
        "@type": "Event",
        name: title,
        startDate: `${date}T12:00:00`,
        endDate: `${date}T13:00:00`,
      };
      const json = `<script type="application/ld+json">${JSON.stringify(event).replaceAll("<", "\\u003c")}</script>`;
      const micro = `<div itemscope itemtype="https://schema.org/Event" itemref="https://evil.test/context"><meta itemprop="name" content="${escapeHtml(title)}"><meta itemprop="startDate" content="${date}T12:00:00"><meta itemprop="endDate" content="${date}T13:00:00"></div>`;
      const a = structuredMailEvents(json, "subject").events[0];
      const b = structuredMailEvents(micro, "subject").events[0];
      expect(a?.title).toBe(title);
      expect(b).toEqual(a);
      expect(a?.start).toEqual({ kind: "floating", value: `${date}T12:00:00` });
    }),
    options,
  );
});

it("calendar containers bound events, deep JSON graphs, NUL and huge calendar properties", () => {
  const event = (i: number) =>
    `BEGIN:VEVENT\r\nUID:${i}\r\nDTSTART:20260101T120000\r\nDTEND:20260101T130000\r\nEND:VEVENT\r\n`;
  expect(
    parseCalendar(
      `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\n${Array.from({ length: 100 }, (_, i) => event(i)).join("")}END:VCALENDAR`,
    ).length,
  ).toBe(20);
  const entries = Array.from({ length: 100 }, (_, i) => ({
    "@type": "Event",
    name: `${i}`,
    startDate: "2026-01-01",
  }));
  expect(
    structuredMailEvents(
      `<script type="application/ld+json">${JSON.stringify(entries)}</script>`,
      "subject",
    ).events.length,
  ).toBe(20);
  const nested = `${'{"@graph":['.repeat(10_000)}null${"]}".repeat(10_000)}`;
  expect(
    structuredMailEvents(`<script type="application/ld+json">${nested}</script>`, "").events,
  ).toEqual([]);
  for (const source of [
    "\0",
    `${"BEGIN:X\r\n".repeat(10_000)}${"END:X\r\n".repeat(10_000)}`,
    `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nDESCRIPTION:${"x".repeat(1024 * 1024)}\r\nEND:VCALENDAR`,
  ]) {
    const started = performance.now();
    expect(parseCalendar(source)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(scaledMs(5000));
  }
});

it("printing decodes obfuscated URL schemes before removing active content", () => {
  for (const href of [
    "java&#x09;script:alert(1)",
    "&#106;avascript:alert(1)",
    "vbscript:alert(1)",
    "data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;",
  ]) {
    const html = `<a href="${href}" onClick = "alert(1)">text</a>`;
    expect(stripActiveContent(html)).toBe("<a>text</a>");
  }
});
