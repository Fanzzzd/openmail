/** Shared thresholds and limits for the browser-free reader model. */
export const MIN_TEXT_CONTRAST = 1.5;
export const COLOUR_MATCH_TOLERANCE = 16;
export const MIN_VISIBLE_ALPHA = 0.1;
export const OVERPAINT_MARGIN_PX = 10;
export const MAX_MEDIA_WIDTH = 8000;
export const MAX_CSS_RULES = 5120;
export const MAX_MATCH_CHECKS = 2_500_000;
export const MAX_SELECTOR_LENGTH = 20_480;
export const MAX_ALTERNATIVES = 256;
export const MAX_REVEAL_INTERVALS = 256;
export const POINT_TO_PIXEL = 4 / 3;
export const EFFECT_PROPERTIES = ["opacity", "filter", "transform", "scale", "zoom"] as const;
export const REPLACED_TAGS: ReadonlySet<string> = new Set(["img", "video", "svg"]);

export function tinyQuantity(quantity: { readonly value: number; readonly unit: string }): boolean {
  return quantity.value <= (["px", "pt", "number"].includes(quantity.unit) ? 2 : 0.2);
}
