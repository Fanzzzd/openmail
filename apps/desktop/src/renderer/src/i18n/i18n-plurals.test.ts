import { expect, it } from "vitest";
import { catalogI18n } from "../test-support/catalog-i18n";

const DELETED =
  "{count, plural, one {Permanently deleted # message} other {Permanently deleted # messages}}";
const EVERY_DAY = "{interval, plural, one {Every # day} other {Every # days}}";

async function render(locale: string, source: string, values: Record<string, number>) {
  const { i18n, catalog } = await catalogI18n(locale);
  const id = Object.entries(catalog).find(([, message]) => message.message === source)?.[0];
  if (!id) throw new Error(`Missing ${source}`);
  return i18n._(id, values);
}

it("counted notices pick the singular in English", async () => {
  expect(await render("en", DELETED, { count: 1 })).toBe("Permanently deleted 1 message");
  expect(await render("en", DELETED, { count: 3 })).toBe("Permanently deleted 3 messages");
  expect(await render("en", EVERY_DAY, { interval: 1 })).toBe("Every 1 day");
});

it("counted notices use each plural form in Russian and Czech", async () => {
  for (const locale of ["ru", "cs"]) {
    const forms = await Promise.all([1, 3, 5].map((count) => render(locale, DELETED, { count })));
    expect(forms[0]).toContain("1");
    // one, few and many differ: the noun after the count changes.
    expect(new Set(forms.map((form) => form.replace(/\d+/, "#"))).size).toBe(3);
  }
});

const HEADER_WINDOW =
  "{0, plural, one {# day} other {# days}}, {1, plural, one {up to # message} other {up to # messages}}";

it("the sync health window counts days and messages with plurals", async () => {
  expect(await render("en", HEADER_WINDOW, { 0: 1, 1: 1 })).toBe("1 day, up to 1 message");
  expect(await render("en", HEADER_WINDOW, { 0: 30, 1: 500 })).toBe("30 days, up to 500 messages");
  expect(await render("ru", HEADER_WINDOW, { 0: 31, 1: 21 })).toBe("31 день, до 21 сообщения");
  expect(await render("ru", HEADER_WINDOW, { 0: 30, 1: 500 })).toBe("30 дней, до 500 сообщений");
  expect(await render("cs", HEADER_WINDOW, { 0: 3, 1: 1 })).toBe("3 dny, nejvýše 1 zpráva");
});
