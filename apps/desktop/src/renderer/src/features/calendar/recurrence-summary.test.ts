import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { formatter } from "@lingui/format-po";
import { createCompiledCatalog } from "@lingui/cli/api";
import { setupI18n, type Messages } from "@lingui/core";
import { expect, it } from "vitest";
import { recurrenceSummary, ORDINAL_LABELS } from "./recurrence-summary";

async function translator(locale: string) {
  const file = new URL(`../../locales/${locale}/messages.po`, import.meta.url);
  const catalog = await formatter().parse(await readFile(file, "utf8"), {
    locale,
    sourceLocale: "en",
    filename: fileURLToPath(file),
  });
  const compiled = createCompiledCatalog(
    locale,
    Object.fromEntries(
      Object.entries(catalog).map(([id, message]) => [id, message.translation ?? ""]),
    ),
    { namespace: "cjs", strict: true },
  );
  expect(compiled.errors).toEqual([]);
  const module: { exports: { messages: Messages } } = { exports: { messages: {} } };
  runInNewContext(compiled.source, { module });
  const i18n = setupI18n({ locale, messages: { [locale]: module.exports.messages } });
  return { i18n, catalog };
}
it("real ICU forms for Czech, Russian and Japanese format every tested count", async () => {
  const countForms = {
    cs: ["1 výskyt", "2 výskyty", "5 výskytů", "21 výskytů"],
    ru: ["1 повторение", "2 повторения", "5 повторений", "21 повторение"],
    ja: ["1回", "2回", "5回", "21回"],
  };
  for (const [locale, forms] of Object.entries(countForms)) {
    const { i18n, catalog } = await translator(locale);
    for (const [index, count] of [1, 2, 5, 21].entries()) {
      const text = recurrenceSummary(
        { pattern: { kind: "daily", interval: count }, ending: { kind: "count", count } },
        i18n._.bind(i18n),
        locale,
      );
      expect(text).toContain(forms[index]);
      expect(text).not.toContain("plural");
    }
    if (locale === "ja")
      for (const entry of Object.values(catalog).filter(
        (value) =>
          value.message?.startsWith("Every {interval, plural") ||
          value.message?.startsWith("{summary}, {count, plural"),
      )) {
        expect(entry.translation).toContain("other {");
        expect(entry.translation).not.toMatch(/\b(?:one|few|many|two|zero)\s*\{/);
      }
  }
});
it("summary dates and weekday conjunctions use Intl and Last has distinct Chinese contexts", async () => {
  const { i18n } = await translator("en");
  const days = new Intl.ListFormat("en", { style: "short", type: "conjunction" }).format([
    "Mon",
    "Wed",
  ]);
  const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    Date.parse("2026-12-31T00:00:00Z"),
  );
  expect(
    recurrenceSummary(
      {
        pattern: { kind: "weekly", interval: 2, weekdays: ["MO", "WE"] },
        ending: { kind: "until", date: "2026-12-31" },
      },
      i18n._.bind(i18n),
      "en",
    ),
  ).toBe(`Every 2 weeks on ${days} until ${date}`);
  const zh = await translator("zh-CN");
  expect(zh.i18n._(ORDINAL_LABELS[-1])).toBe("最后一个");
  expect(
    recurrenceSummary(
      {
        pattern: { kind: "monthly-weekday", interval: 1, ordinal: -1, weekday: "MO" },
        ending: { kind: "never" },
      },
      zh.i18n._.bind(zh.i18n),
      "zh-CN",
    ),
  ).toContain("最后一个周一");
});
