import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import { TITLEBAR_HEIGHT } from "../../../shared/window-chrome";
import { desktopRoot } from "../test-support/paths";
import { titlebarRow } from "./styles";

const renderer = path.join(desktopRoot, "src/renderer/src");
const components = readdirSync(renderer, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
  .map((file) => ({ file, source: readFileSync(path.join(renderer, file), "utf8") }));

it("makes the first row as tall as the row main centres the traffic lights in", () => {
  // Tailwind's h-13 is 13 × 4 px.
  expect(titlebarRow.split(" ")).toContain("h-13");
  expect(13 * 4).toBe(TITLEBAR_HEIGHT);
  expect(titlebarRow.split(" ")).toContain("drag");
});

it("builds every row under the traffic lights from titlebarRow", () => {
  const spaced = components.filter(({ source }) => source.includes("<TrafficLightSpace"));
  expect(spaced.length).toBeGreaterThan(5);
  for (const { file, source } of spaced) expect(source, file).toContain("titlebarRow");
  // A first row spelled out by hand could drift from 52 px.
  for (const { file, source } of components)
    expect(source, file).not.toMatch(
      /["`][^"`]*\bdrag\b[^"`]*\bh-13\b|["`][^"`]*\bh-13\b[^"`]*\bdrag\b/,
    );
});
