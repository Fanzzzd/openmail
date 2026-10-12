import { Schema } from "effect";

/**
 * Geometry of the macOS traffic lights (close, minimize, zoom). Main places
 * them with `setWindowButtonPosition`, centred in the header row the renderer
 * reports. The renderer reads their real bounds from the Window Controls
 * Overlay API (`navigator.windowControlsOverlay`): its titlebar area starts
 * one inset to the right of the zoom button, and spans the lights' row.
 * Window points equal CSS pixels at zoom 1.
 */
export const TRAFFIC_LIGHTS = {
  /** From the window's left edge to the close button. */
  inset: 18,
  /** One button's diameter on macOS 26. */
  size: 14,
  /**
   * Close to zoom on macOS 26: three 14 pt buttons 23 pt apart. Only a
   * fallback; AppKit decides the real width and the overlay reports it.
   */
  width: 60,
} as const;

/** The first toolbar row of every window: Tailwind's h-13. */
export const TITLEBAR_HEIGHT = 52;
const MAX_TITLEBAR = 160;

/** A header height the renderer may report, in CSS pixels. */
export const TitlebarHeight = Schema.Number.check(
  Schema.isBetween({ minimum: TRAFFIC_LIGHTS.size, maximum: MAX_TITLEBAR }),
);

/**
 * The window-point position that centres the buttons in a header of
 * `headerHeight` CSS pixels. The native buttons do not scale with page zoom,
 * so the header's height in points is its CSS height times the zoom factor.
 * The left inset stays put, so the lights never move sideways.
 */
export function trafficLightPosition(headerHeight: number, zoom = 1) {
  const height = Math.min(MAX_TITLEBAR, Math.max(TRAFFIC_LIGHTS.size, headerHeight)) * zoom;
  return { x: TRAFFIC_LIGHTS.inset, y: Math.floor((height - TRAFFIC_LIGHTS.size) / 2) };
}

/**
 * The part of the lights' row that is free for content, in CSS pixels, as
 * `navigator.windowControlsOverlay.getTitlebarAreaRect()` reports it. Its
 * left edge is where a title may start; its height is the lights' row.
 */
export interface TitlebarArea {
  x: number;
  y: number;
  height: number;
}

/** The area where main first puts the lights, for renderers without the overlay API. */
export const DEFAULT_TITLEBAR_AREA: TitlebarArea = {
  x: TRAFFIC_LIGHTS.inset * 2 + TRAFFIC_LIGHTS.width,
  y: 0,
  height: TITLEBAR_HEIGHT,
};

/** A box in window CSS pixels. */
interface Box {
  left: number;
  top: number;
  bottom: number;
}

/**
 * The width a spacer starting at `box.left` needs so what follows it starts
 * at the titlebar area's left edge. Zero when the box is beside or below the
 * lights, or when there are none: full screen, other platforms, the web build.
 */
export function trafficLightSpace(area: TitlebarArea | null, box: Box): number {
  if (!area) return 0;
  if (box.top >= area.y + area.height || box.bottom <= area.y) return 0;
  return Math.max(0, Math.ceil(area.x - box.left));
}

/**
 * The height a full-window sheet keeps clear at its top: the lights' row.
 * Zero without lights.
 */
export const trafficLightClearance = (area: TitlebarArea | null) =>
  area ? Math.ceil(area.y + area.height) : 0;

/**
 * Whether the header row starting at `row` is the one the lights sit in:
 * it starts at the window's top and its leading edge is under the buttons.
 */
export const holdsTrafficLights = (area: TitlebarArea | null, row: Box, leading: number) =>
  area !== null && row.top <= 0.5 && row.bottom > row.top && leading < area.x;
