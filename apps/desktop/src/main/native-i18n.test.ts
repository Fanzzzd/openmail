import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(async () => ({})) }));
vi.mock("electron", () => ({
  app: {
    getPreferredSystemLanguages: () => ["pt-BR", "de-AT", "ja-JP"],
    getLocale: () => "en",
  },
}));
vi.mock("../shared/catalogs", () => ({ loadCatalog: mocks.load }));
import { nativeRecoveryLabels } from "./native-i18n";

it("main loads only the first supported preferred language, including preferences after an unsupported language", async () => {
  expect(mocks.load).not.toHaveBeenCalled();
  await nativeRecoveryLabels();
  expect(mocks.load.mock.calls).toEqual([["de"]]);
});
