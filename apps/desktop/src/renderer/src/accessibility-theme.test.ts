import Color from "colorjs.io";
import { builtStyles } from "./test-styles";
import { labelChipColors } from "./label-colors";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
function luminance(hex: string) {
  const channels = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

for (const [index, theme] of ["light", "dark"].entries()) {
  it(`${theme} text, controls and focus tokens meet WCAG AA`, () => {
    const block = [...css.matchAll(/:root\s*\{([^}]+)\}/g)][index]?.[1];
    expect(block).toBeTruthy();
    const tokens = new Map(
      [...(block?.matchAll(/--a11y-([\w-]+):\s*(#[\da-f]{6})/g) ?? [])].map((match) => [
        match[1],
        match[2],
      ]),
    );
    for (const surface of ["surface", "surface-muted"]) {
      const background = tokens.get(surface);
      if (!background) throw new Error(`Missing ${theme} ${surface}`);
      for (const token of ["text", "muted", "accent", "danger", "border", "focus"]) {
        const foreground = tokens.get(token);
        if (!foreground) throw new Error(`Missing ${theme} ${token}`);
        expect(
          contrast(foreground, background),
          `${theme} ${token} on ${surface}`,
        ).toBeGreaterThanOrEqual(token === "focus" || token === "border" ? 3 : 4.5);
      }
    }
    // Accent menus and action buttons use opaque white text on blue-600.
    expect(contrast("#ffffff", "#2563eb")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", "#dc2626")).toBeGreaterThanOrEqual(4.5);
  });
}

it("applies contrast tokens to focus and control outlines and disables motion globally", () => {
  expect(css).toContain("outline: 2px solid var(--a11y-focus)");
  expect(css).toContain("border-color: var(--a11y-border)");
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/);
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition: none !important/);
  expect(css).toContain("max-width: calc(100vw - 24px)");
  expect(css).toContain("overflow-y: auto");
});

it("checks hard-coded text and icon utility colors from the shipped CSS", () => {
  const styles = builtStyles();
  const tokens = new Map<string, string>();
  styles.walkDecls(/^--color-/, (decl) => {
    tokens.set(decl.prop, decl.value);
  });
  const textCases: readonly [string, string][] = [
    ["orange-700", "#ffffff"],
    ["orange-400", "#262626"],
    ["violet-700", "#ffffff"],
    ["violet-300", "#262626"],
    ["violet-800", "#ede9fe"],
    ["violet-200", "#262626"],
    ["blue-800", "#eaf0fd"],
    ["blue-200", "#262626"],
    ["red-700", "#fce9e9"],
    ["red-300", "#262626"],
    ["blue-300", "#171717"],
    ["blue-600", "#f5f5f5"],
    ["neutral-600", "#ffffff"],
    ["neutral-300", "#262626"],
  ];
  for (const [token, background] of textCases) {
    const foreground = tokens.get(`--color-${token}`);
    if (!foreground) throw new Error(`Missing built text token ${token}`);
    expect(
      new Color(foreground).contrast(background, "WCAG21"),
      `text-${token} on ${background}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  for (const token of [
    "amber-600",
    "orange-600",
    "violet-600",
    "emerald-600",
    "sky-600",
    "blue-600",
    "red-600",
  ]) {
    const foreground = tokens.get(`--color-${token}`);
    if (!foreground) throw new Error(`Missing built icon token ${token}`);
    expect(
      new Color(foreground).contrast("#f9f9f9", "WCAG21"),
      `${token} sidebar icon`,
    ).toBeGreaterThanOrEqual(3);
  }
});

it("retains user label hues with readable foregrounds on both themes and selected rows", () => {
  for (const color of [
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#ffff00",
    "#abcdef",
    "#000000",
    "#ffffff",
    "#f97316",
  ]) {
    const style = labelChipColors(color);
    expect(style.backgroundColor).toBe(`${color}33`);
    for (const [foreground, surfaces] of [
      [style["--label-text-light"], ["#ffffff", "#f5f5f5", "#ededed"]],
      [style["--label-text-dark"], ["#171717", "#262626", "#303030"]],
    ] as const) {
      const rgb = new Color(color).to("srgb").coords;
      for (const surface of surfaces) {
        const base = new Color(surface).to("srgb").coords;
        const channel = (index: 0 | 1 | 2) => (rgb[index] ?? 0) * 0.2 + (base[index] ?? 0) * 0.8;
        const tinted = new Color("srgb", [channel(0), channel(1), channel(2)]);
        expect(
          new Color(foreground).contrast(tinted, "WCAG21"),
          `${color} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  // A red label stays red, rather than falling back to neutral message text.
  expect(labelChipColors("#ff0000")["--label-text-light"]).toMatch(/^#[a-f\d]{2}0000$/);
});
