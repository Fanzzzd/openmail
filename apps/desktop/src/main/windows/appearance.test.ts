import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false }, nativeTheme: { themeSource: "system" } }));
import { developmentAppearance } from "./appearance";

it("OPENMAIL_APPEARANCE forces light or dark only in development builds", () => {
  expect(developmentAppearance("light", false)).toBe("light");
  expect(developmentAppearance("dark", false)).toBe("dark");
  expect(developmentAppearance("light", true)).toBeUndefined();
  expect(developmentAppearance("dark", true)).toBeUndefined();
  expect(developmentAppearance("system", false)).toBeUndefined();
  expect(developmentAppearance("Light", false)).toBeUndefined();
  expect(developmentAppearance(undefined, false)).toBeUndefined();
});
