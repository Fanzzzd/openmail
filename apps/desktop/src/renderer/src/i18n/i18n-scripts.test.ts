import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

/** Latin words a translation may use although the English source does not spell them. */
const LATIN_ALLOWED = new Set(["CC", "BCC"]);

/** Placeholders, component tags, ICU plural/select keywords and `#` are not words. */
const visibleText = (text: string) =>
  text
    .replace(/\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,/g, " ")
    .replace(/(?:^|\s|\})(?:zero|one|two|few|many|other|=\d+)\s*\{/g, " ")
    .replace(/\{[^{}]*\}|<\/?\d+\/?>|#/g, " ");

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Words mixing scripts, such as a Latin "o" inside a Cyrillic word, or Latin text in a
 * Russian, Japanese or Chinese translation that the English source never had. Brand names
 * and terms like MCP or API pass because the source spells them the same way.
 */
function mixedScriptProblems(locale: string, source: string, target: string): string[] {
  const problems: string[] = [];
  const text = visibleText(target);
  const sourceWords =
    visibleText(source)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  // "Web" for "webmail" and "Profile" for "profiles" keep the source's own spelling.
  const fromSource = (run: string) =>
    LATIN_ALLOWED.has(run) || sourceWords.some((w) => w.startsWith(run.toLowerCase()));
  // Hyphens join "MCP-сервер" style compounds; each part is its own word.
  for (const word of text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (locale === "ru" && CYRILLIC.test(word) && LATIN.test(word)) problems.push(word);
    if (locale === "ja" || locale === "zh-CN") {
      if (CJK.test(word) && LATIN.test(word)) {
        // A Latin run glued inside CJK text: allowed only for words the source has.
        for (const run of word.match(/\p{Script=Latin}[\p{Script=Latin}\p{N}]*/gu) ?? [])
          if (!fromSource(run)) problems.push(run);
        continue;
      }
    }
    if (
      (locale === "ru" || locale === "ja" || locale === "zh-CN") &&
      LATIN.test(word) &&
      !CYRILLIC.test(word) &&
      !CJK.test(word) &&
      !fromSource(word)
    )
      problems.push(word);
  }
  return problems;
}

it("flags mixed-script words and stray Latin, and allows brands and placeholders", () => {
  expect(mixedScriptProblems("ru", "Mail", "Пoчта")).toEqual(["Пoчта"]);
  expect(mixedScriptProblems("ru", "Start the MCP server", "Запустить MCP-сервер")).toEqual([]);
  expect(
    mixedScriptProblems(
      "ru",
      "{count, plural, one {# day} few {# days} many {# days} other {# days}}",
      "{count, plural, one {# день} few {# дня} many {# дней} other {# дня}}",
    ),
  ).toEqual([]);
  expect(mixedScriptProblems("ru", "Archive", "Архив draft")).toEqual(["draft"]);
  expect(mixedScriptProblems("ja", "Open AI Access", "AIアクセスを開く")).toEqual([]);
  expect(mixedScriptProblems("ja", "Settings", "設定x画面")).toEqual(["x"]);
  expect(mixedScriptProblems("zh-CN", "Hello {name}", "你好 {name}")).toEqual([]);
  expect(mixedScriptProblems("zh-CN", "Install it", "安装 app")).toEqual(["app"]);
});

it("Russian, Japanese and Chinese catalogs have no mixed-script words or stray Latin", async () => {
  const po = formatter();
  const failures: string[] = [];
  for (const locale of ["ru", "ja", "zh-CN"]) {
    const file = new URL(`../locales/${locale}/messages.po`, import.meta.url);
    const catalog = await po.parse(await readFile(file, "utf8"), {
      locale,
      sourceLocale: "en",
      filename: fileURLToPath(file),
    });
    for (const message of Object.values(catalog)) {
      const source = message.message ?? "";
      const problems = mixedScriptProblems(locale, source, message.translation ?? "");
      if (problems.length) failures.push(`${locale}: ${problems.join(", ")}: ${source}`);
    }
  }
  expect(failures).toEqual([]);
});
