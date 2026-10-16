import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

/**
 * Words a translation may start with in lowercase: brand names, the Tailscale term tailnet,
 * and identifiers the user types as they are.
 */
const LOWERCASE_STARTS = [
  "iCloud",
  "iPad",
  "iPhone",
  "macOS",
  "tailnet",
  "openmail",
  "winmail.dat",
  "from:",
  "svc:",
  "name@github",
  "http",
];

const LOCALES = ["zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"];

async function catalog(app: "desktop" | "mobile", locale: string) {
  const file =
    app === "desktop"
      ? new URL(`../locales/${locale}/messages.po`, import.meta.url)
      : new URL(`../../../../../mobile/src/locales/${locale}/messages.po`, import.meta.url);
  return formatter().parse(await readFile(file, "utf8"), {
    locale,
    sourceLocale: "en",
    filename: fileURLToPath(file),
  });
}

// Czech "kurzíva" for Italic and French "serveur IMAP" for IMAP server put a lowercase label
// next to capitalised ones. Sentence case starts every label and sentence with a capital.
it.for(["desktop", "mobile"] as const)(
  "%s translations of capitalised English text start with a capital",
  async (app) => {
    const english = await catalog(app, "en");
    const lowercase: string[] = [];
    for (const locale of LOCALES)
      for (const [id, message] of Object.entries(await catalog(app, locale))) {
        const source = english[id]?.translation || english[id]?.message || id;
        const translation = message.translation ?? "";
        if (!/^\p{Lu}/u.test(source) || !/^\p{Ll}/u.test(translation)) continue;
        if (LOWERCASE_STARTS.some((start) => translation.startsWith(start))) continue;
        lowercase.push(`${locale}: ${source} -> ${translation}`);
      }
    expect(lowercase).toEqual([]);
  },
);
