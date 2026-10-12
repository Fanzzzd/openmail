import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(async () => ({})) }));
vi.mock("electron", () => ({
  app: {
    getPreferredSystemLanguages: () => ["pt-BR", "de-AT", "ja-JP"],
    getLocale: () => "en",
  },
}));
vi.mock("../../shared/catalogs", () => ({ loadCatalog: mocks.load }));
import { nativeAuthorizePage, nativeRecoveryLabels, setNativeLanguage } from "./native-i18n";

it("main loads only the first supported preferred language, including preferences after an unsupported language", async () => {
  expect(mocks.load).not.toHaveBeenCalled();
  await nativeRecoveryLabels();
  expect(mocks.load.mock.calls).toEqual([["de"]]);
});

it("the sign-in result page follows the language setting, then the system language", async () => {
  mocks.load.mockClear();
  expect((await nativeAuthorizePage()).lang).toBe("de");
  setNativeLanguage("ja");
  const page = await nativeAuthorizePage();
  expect(page.lang).toBe("ja");
  expect(Object.keys(page)).toEqual(["lang", "title", "doneText", "failedText"]);
  expect(mocks.load.mock.calls).toEqual([["de"], ["ja"]]);
  setNativeLanguage("system");
});
