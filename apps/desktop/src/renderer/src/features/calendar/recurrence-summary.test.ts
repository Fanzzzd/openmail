import { expect, it } from "vitest";
import { catalogI18n } from "../../test-support/catalog-i18n";
import { recurrenceSummary, ORDINAL_LABELS } from "./recurrence-summary";

it("real ICU forms for Czech, Russian and Japanese format every tested count", async () => {
  const countForms = {
    cs: ["1 výskyt", "2 výskyty", "5 výskytů", "21 výskytů"],
    ru: ["1 повторение", "2 повторения", "5 повторений", "21 повторение"],
    ja: ["1回", "2回", "5回", "21回"],
  };
  for (const [locale, forms] of Object.entries(countForms)) {
    const { i18n, catalog } = await catalogI18n(locale);
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
  const { i18n } = await catalogI18n("en");
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
  const zh = await catalogI18n("zh-CN");
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
