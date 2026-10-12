import { expect, it } from "vitest";

import {
  TITLEBAR_HEIGHT,
  TRAFFIC_LIGHT_POSITION,
  trafficLightClearance,
  trafficLightSpace,
} from "./window-chrome";

it("centres the 14 pt buttons in the 52 px first row", () => {
  expect(TITLEBAR_HEIGHT).toBe(52);
  expect(TRAFFIC_LIGHT_POSITION).toEqual({ x: 18, y: 19 });
});

it("sizes a spacer to reach the free area from wherever its row starts", () => {
  // macOS 26: close at 18 pt, zoom ending at 78 pt, then the same 18 pt inset.
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
});

it("keeps the lights' row clear above a full-window sheet", () => {
  expect(trafficLightClearance({ x: 96, y: 0, height: 52 })).toBe(52);
  expect(trafficLightClearance({ x: 96, y: 0, height: 44.4 })).toBe(45);
});
