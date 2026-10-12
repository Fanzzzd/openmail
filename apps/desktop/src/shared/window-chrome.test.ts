import { Schema } from "effect";
import { expect, it } from "vitest";

import {
  DEFAULT_TITLEBAR_AREA,
  holdsTrafficLights,
  TitlebarHeight,
  trafficLightClearance,
  trafficLightPosition,
  trafficLightSpace,
} from "./window-chrome";

it("centres the 14 pt buttons in the reported header and keeps their left inset", () => {
  expect(trafficLightPosition(52)).toEqual({ x: 18, y: 19 });
  expect(trafficLightPosition(44)).toEqual({ x: 18, y: 15 });
  // A header twice as tall in points under 2x page zoom; the inset stays.
  expect(trafficLightPosition(52, 2)).toEqual({ x: 18, y: 45 });
  // Out-of-range heights clamp instead of pushing the buttons off the window.
  expect(trafficLightPosition(4)).toEqual({ x: 18, y: 0 });
  expect(trafficLightPosition(10_000).y).toBe(73);
});

it("starts the default free area one inset after the zoom button", () => {
  // Close at 18 pt, zoom ending at 78 pt on macOS 26, then the same 18 pt inset.
  expect(DEFAULT_TITLEBAR_AREA).toEqual({ x: 96, y: 0, height: 52 });
});

it("sizes a spacer to reach the free area from wherever its row starts", () => {
  const area = { x: 96, y: 0, height: 52 };
  const row = (left: number, top = 0) => ({ left, top, bottom: top + 52 });
  // Window edge, the 56 px rail plus 20 px padding, beside a docked sidebar.
  expect(trafficLightSpace(area, row(0))).toBe(96);
  expect(trafficLightSpace(area, row(76))).toBe(20);
  expect(trafficLightSpace(area, row(260))).toBe(0);
  // A row below the lights' row, and fractional layout rounds up.
  expect(trafficLightSpace(area, row(0, 52))).toBe(0);
  expect(trafficLightSpace(area, row(15.5))).toBe(81);
});

it("reserves nothing without lights: full screen, other platforms, the web build", () => {
  expect(trafficLightSpace(null, { left: 0, top: 0, bottom: 52 })).toBe(0);
  expect(trafficLightClearance(null)).toBe(0);
  expect(holdsTrafficLights(null, { left: 0, top: 0, bottom: 52 }, 0)).toBe(false);
});

it("keeps the lights' row clear above a full-window sheet", () => {
  expect(trafficLightClearance({ x: 96, y: 0, height: 52 })).toBe(52);
  expect(trafficLightClearance({ x: 96, y: 0, height: 44.4 })).toBe(45);
});

it("lets only the top row whose leading edge is under the buttons set their height", () => {
  const area = { x: 96, y: 0, height: 52 };
  expect(holdsTrafficLights(area, { left: 0, top: 0, bottom: 52 }, 12)).toBe(true);
  expect(holdsTrafficLights(area, { left: 0, top: 52, bottom: 104 }, 12)).toBe(false);
  expect(holdsTrafficLights(area, { left: 260, top: 0, bottom: 52 }, 280)).toBe(false);
  // An unlaid-out row (no height) reports nothing.
  expect(holdsTrafficLights(area, { left: 0, top: 0, bottom: 0 }, 0)).toBe(false);
});

it("accepts header heights the buttons fit in", () => {
  const decode = Schema.decodeUnknownOption(TitlebarHeight);
  expect(decode(52)._tag).toBe("Some");
  expect(decode(13)._tag).toBe("None");
  expect(decode(161)._tag).toBe("None");
});
