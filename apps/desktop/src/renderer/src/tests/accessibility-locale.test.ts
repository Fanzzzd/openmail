// @vitest-environment jsdom
import { afterAll, expect, it, vi } from "vitest";
import { LANGUAGES } from "@openmail/core/schema";

// Catalog loading is IO; exercise the renderer's real activation callback.
vi.mock("../../../shared/catalogs", () => ({ loadCatalog: async () => ({}) }));
import { activateLocale, i18n } from "../i18n/i18n";

for (const locale of LANGUAGES) {
  if (locale === "system") continue;
  it(`sets the document language when ${locale} activates`, async () => {
    expect(await activateLocale(locale)).toBe(true);
    expect(i18n.locale).toBe(locale);
    expect(document.documentElement.lang).toBe(locale);
  });
}

afterAll(() => {
  vi.doUnmock("../../../shared/catalogs");
  vi.resetModules();
});
