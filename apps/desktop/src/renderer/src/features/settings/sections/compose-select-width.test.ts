import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { desktopRoot } from "../../../test-support/paths";

const root = `${desktopRoot}/src/renderer/src`;
const source = readFileSync(`${root}/features/settings/sections/ComposeSettings.tsx`, "utf8");

/** Reply from, default-sender and quote options: the values these triggers show. */
const OPTIONS = [
  "Use the address the message was sent to",
  "Use the account default address",
  "Use the current account",
  "Always quote the whole message",
];

function translation(locale: string, msgid: string): string {
  const po = readFileSync(`${root}/locales/${locale}/messages.po`, "utf8");
  const match = new RegExp(`msgid "${msgid}"\\nmsgstr "([^"]+)"`).exec(po);
  if (!match) throw new Error(`no ${locale} translation of ${msgid}`);
  return match[1]!;
}

// At 1320 px the ru, cs, es and ja triggers cut their value ("Использовать адрес, на которы…")
// because they were capped at max-w-64 (256 px).
it("gives the compose selects room for their longest translated value", () => {
  expect(source).not.toContain("max-w-64");
  const cap = /const wideSelect = "max-w-(\w+) /.exec(source)?.[1];
  const capPx = { md: 448, lg: 512, xl: 576 }[cap ?? ""];
  if (!capPx) throw new Error(`unexpected wideSelect cap ${cap}`);
  // 13 px text: ~7.5 px per Latin or Cyrillic letter, 13 px per CJK character, plus the
  // trigger's padding and the chevron.
  for (const locale of ["ru", "cs", "es", "ja", "de"])
    for (const option of OPTIONS) {
      const text = translation(locale, option);
      const width = Array.from(text).reduce(
        (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 13 : 7.5),
        56,
      );
      expect(width, `${locale}: ${text}`).toBeLessThanOrEqual(capPx);
    }
});

it("applies the wide cap to the reply-from and default-sender selects", () => {
  expect(source.match(/className=\{wideSelect\}/g)?.length).toBeGreaterThanOrEqual(2);
});
