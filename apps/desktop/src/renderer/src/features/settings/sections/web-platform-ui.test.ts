// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { cleanup, render, screen } from "@testing-library/react";
import { AsyncResult } from "effect/reactivity";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(DEFAULT_PREFS),
  useAtomSet: () => vi.fn(),
}));
vi.mock("../../../state/queries", () => ({ prefsAtom: "prefs" }));
vi.mock("../../../state/mutations", () => ({ setPrefsAtom: "setPrefs" }));
vi.mock("./IndexingSettings", () => ({ IndexingSettings: () => null }));
vi.mock("../../../lib/responsive-layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/responsive-layout")>()),
  useLayoutMode: () => "narrow",
}));

import { desktopRoot } from "../../../test-support/paths";
import { setPlatform } from "../../../lib/platform";
import { Dialog, narrowSheet, SheetDragStrip } from "../../../ui/Dialog";
import { buttonSecondary, iconButton, itemClass, touchTarget } from "../../../ui/styles";
import { TrafficLightSpace } from "../../../ui/TrafficLights";
import { InteractionSettings } from "./InteractionSettings";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "windowControlsOverlay");
  setPlatform("desktop");
});
const localized = (node: ReactNode) =>
  h(I18nProvider, { i18n: setupI18n({ locale: "en", messages: { en: {} } }) }, node);

it("hides the swipe settings in the web build, where nothing sends two-finger swipes", () => {
  render(localized(h(InteractionSettings)));
  expect(screen.queryByText("Swipe actions")).not.toBeNull();
  cleanup();
  setPlatform("web");
  render(localized(h(InteractionSettings)));
  expect(screen.queryByText("Swipe actions")).toBeNull();
  expect(screen.queryByText("Toolbar actions")).not.toBeNull();
});

it("keeps the traffic-light clearance on the Mac only", () => {
  const overlay = Object.assign(new EventTarget(), {
    visible: true,
    getTitlebarAreaRect: () => DOMRect.fromRect({ x: 96, y: 0, width: 904, height: 52 }),
  });
  Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: overlay });
  const header = () => render(h("header", null, h(TrafficLightSpace)));
  expect(narrowSheet()).toContain("max-sm:pt-(--titlebar-clearance)");
  // No transform on a full-window sheet, so its fixed strip and close button
  // stay under the lights while the sheet's content scrolls.
  expect(narrowSheet()).toContain("max-sm:translate-none");
  render(h(SheetDragStrip));
  expect(document.querySelector(".drag")?.className).toContain("fixed");
  header();
  expect(document.querySelector("[data-traffic-light-space]")).not.toBeNull();
  cleanup();

  setPlatform("web");
  expect(narrowSheet()).not.toContain("titlebar-clearance");
  render(h(SheetDragStrip));
  expect(document.querySelector(".drag")).toBeNull();
  header();
  expect(document.querySelector("[data-traffic-light-space]")).toBeNull();
  render(localized(h(Dialog, { "aria-label": "Example", onClose: () => null, children: "Body" })));
  expect(screen.getByRole("dialog").className).not.toContain("titlebar-clearance");
  expect(screen.getByRole("dialog").className).toContain("sm:max-h-[calc(100dvh-24px)]");
});

it("keeps a centred sheet's top edge below the traffic lights on the Mac", () => {
  render(localized(h(Dialog, { "aria-label": "Example", onClose: () => null, children: "Body" })));
  // Centred, so a sheet at most the window minus twice the lights' row starts below it.
  const classes = screen.getByRole("dialog").className.split(" ");
  expect(classes).toContain("sm:max-h-[calc(100dvh-2*var(--titlebar-clearance,12px))]");
  // Content taller than the cap scrolls, so a confirm button can't fall below a short window.
  expect(classes).toContain("overflow-y-auto");
  cleanup();
  render(
    localized(
      h(Dialog, {
        "aria-label": "Own scroll",
        onClose: () => null,
        className: "overflow-hidden",
        children: "",
      }),
    ),
  );
  expect(screen.getByRole("dialog").className.split(" ")).not.toContain("overflow-y-auto");
  cleanup();
  // A lower cap goes through Dialog's maxHeight, still bounded by the window.
  render(
    localized(
      h(Dialog, { "aria-label": "Capped", onClose: () => null, maxHeight: "600px", children: "" }),
    ),
  );
  const capped = screen.getByRole("dialog").className.split(" ");
  expect(capped).toContain("sm:max-h-[min(600px,calc(100dvh-2*var(--titlebar-clearance,12px)))]");
  expect(capped.filter((name) => name.includes("max-h-"))).toHaveLength(2);
  // Callers leave the max height to Dialog's maxHeight; a max-h class of theirs would fight it.
  const root = path.join(desktopRoot, "src/renderer/src");
  const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".tsx"),
  );
  for (const file of sources) {
    const source = readFileSync(path.join(root, file), "utf8");
    // The className before the next tag starts is the Dialog's own.
    for (const [, classes] of source.matchAll(
      /<Dialog\b(?:(?!<[A-Za-z])[\s\S])*?className="([^"]*)"/g,
    ))
      expect(classes, file).not.toMatch(/(^|\s)max-h-/);
  }
});

it("gives buttons, icon buttons and menu rows a 40 px target on a phone in the web build", () => {
  for (const recipe of [buttonSecondary, iconButton, itemClass])
    expect(recipe).toContain("coarse:min-h-10");
  expect(touchTarget).toBe("coarse:min-h-10 coarse:min-w-10");
  const css = readFileSync(path.join(desktopRoot, "src/renderer/src/styles.css"), "utf8");
  // The variant only matches the web build, so the Mac app keeps its sizes.
  expect(css).toMatch(
    /@custom-variant coarse \{\s*@media \(pointer: coarse\) \{\s*&:where\(\[data-platform="web"\] \*\)/,
  );
  const html = readFileSync(path.join(desktopRoot, "src/renderer/web.html"), "utf8");
  expect(html).toContain('<html lang="en" data-platform="web">');
  expect(readFileSync(path.join(desktopRoot, "src/renderer/index.html"), "utf8")).not.toContain(
    "data-platform",
  );
});
