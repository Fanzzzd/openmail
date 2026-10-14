import { expect, it } from "vitest";

import { PANE_MIN } from "./layout";
import {
  dividerClearsLights,
  trafficLightSpacer,
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

it("puts a row's first item at the free area's edge, gap included", () => {
  // The list header beside the 56 px rail, 20 px padding, 8 px gap: 20 px to go.
  expect(trafficLightSpacer(20, 8)).toEqual({ shown: true, width: 12, marginEnd: 0 });
  // The overview header beside the rail, 28 px padding, 12 px gap: the gap alone overshoots.
  expect(trafficLightSpacer(12, 12)).toEqual({ shown: true, width: 0, marginEnd: 0 });
  expect(trafficLightSpacer(5, 12)).toEqual({ shown: true, width: 0, marginEnd: -7 });
  // Already clear: no spacer and no gap.
  expect(trafficLightSpacer(0, 8)).toEqual({ shown: false, width: 0, marginEnd: 0 });
});

it("keeps every pane divider out of the lights", () => {
  const area = { x: 96, y: 0, height: TITLEBAR_HEIGHT };
  // The rail is narrower than the lights, so its divider starts below their row.
  expect(PANE_MIN.rail).toBeLessThan(area.x);
  expect(dividerClearsLights(area, { x: PANE_MIN.rail, top: TITLEBAR_HEIGHT })).toBe(true);
  expect(dividerClearsLights(area, { x: PANE_MIN.rail, top: 0 })).toBe(false);
  // A docked sidebar at its narrowest still ends right of the lights.
  expect(dividerClearsLights(area, { x: PANE_MIN.sidebar, top: 0 })).toBe(true);
  // The window edge and full screen draw nothing to avoid.
  expect(dividerClearsLights(area, { x: 0, top: 0 })).toBe(true);
  expect(dividerClearsLights(null, { x: 56, top: 0 })).toBe(true);
});
