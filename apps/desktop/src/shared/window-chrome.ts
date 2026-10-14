/**
 * Geometry of the macOS traffic lights (close, minimize, zoom). Every
 * window's first row is TITLEBAR_HEIGHT tall (the renderer's `titlebarRow`
 * recipe), and main centres the buttons in it once, at window creation. The
 * renderer reads their real bounds from the Window Controls Overlay API
 * (`navigator.windowControlsOverlay`): its titlebar area starts one inset to
 * the right of the zoom button and spans the lights' row. The app has no
 * page zoom, so window points equal CSS pixels.
 */

/** The first row of every window: Tailwind's h-13. */
export const TITLEBAR_HEIGHT = 52;

/** One button's diameter on macOS 26. */
const BUTTON_SIZE = 14;

/** Close button 18 pt from the left edge, the buttons centred in the first row. */
export const TRAFFIC_LIGHT_POSITION = {
  x: 18,
  y: Math.floor((TITLEBAR_HEIGHT - BUTTON_SIZE) / 2),
} as const;

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
 * Whether a vertical pane divider at `x`, drawn from `top` down, stays clear
 * of the lights: right of their free area's left edge, or below their row.
 */
export const dividerClearsLights = (
  area: TitlebarArea | null,
  divider: { x: number; top: number },
) => !area || divider.x <= 0 || divider.x >= area.x || divider.top >= area.y + area.height;

/**
 * The spacer that puts a row's first item at the free area's left edge.
 * `need` is the distance from the row's content start (after its border and
 * padding) to that edge, from trafficLightSpace. A shown spacer adds the
 * row's `gap` after itself, so it is that much narrower, and when the gap
 * alone overshoots, a negative end margin takes the rest back. A row that
 * needs nothing drops the spacer, gap and all.
 */
export function trafficLightSpacer(need: number, gap: number) {
  if (need <= 0) return { shown: false, width: 0, marginEnd: 0 };
  return { shown: true, width: Math.max(0, need - gap), marginEnd: Math.min(0, need - gap) };
}

/** The height a full-window sheet keeps clear at its top: the lights' row. Zero without lights. */
export const trafficLightClearance = (area: TitlebarArea | null) =>
  area ? Math.ceil(area.y + area.height) : 0;
