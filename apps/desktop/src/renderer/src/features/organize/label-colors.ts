import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/** The colors Settings > Organize offers for a label or folder. */
export const LABEL_COLORS = [
  { value: "#4986e7", name: msg({ context: "label color", message: "Blue" }) },
  { value: "#fb4c2f", name: msg({ context: "label color", message: "Red" }) },
  { value: "#fbe983", name: msg({ context: "label color", message: "Yellow" }) },
  { value: "#16a765", name: msg({ context: "label color", message: "Green" }) },
  { value: "#b99aff", name: msg({ context: "label color", message: "Purple" }) },
] as const;

/** More names for a color set elsewhere, such as in Gmail; only used to describe it. */
const OTHER_NAMES = [
  { value: "#ffad47", name: msg({ context: "label color", message: "Orange" }) },
  { value: "#f691b2", name: msg({ context: "label color", message: "Pink" }) },
  { value: "#2da2bb", name: msg({ context: "label color", message: "Teal" }) },
  { value: "#999999", name: msg({ context: "label color", message: "Gray" }) },
];

export const CUSTOM_COLOR = msg({
  context: "label color",
  comment: "A label color that is not close to any named color.",
  message: "Custom color",
});

const rgb = (hex: string): readonly [number, number, number] | undefined => {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match?.[1]) return undefined;
  const digits =
    match[1].length === 3 ? match[1].replace(/./g, (digit) => digit + digit) : match[1];
  const channel = (at: number) => Number.parseInt(digits.slice(at, at + 2), 16);
  return [channel(0), channel(2), channel(4)];
};

/** Farther than this in RGB, a color is named Custom color rather than a near name. */
const NEAR = 80;

/** The name of the closest named color, or Custom color when none is near. */
export function labelColorName(color: string): MessageDescriptor {
  const target = rgb(color);
  if (!target) return CUSTOM_COLOR;
  let best: { name: MessageDescriptor; distance: number } = { name: CUSTOM_COLOR, distance: NEAR };
  for (const named of [...LABEL_COLORS, ...OTHER_NAMES]) {
    const other = rgb(named.value);
    if (!other) continue;
    const distance = Math.hypot(...target.map((channel, index) => channel - (other[index] ?? 0)));
    if (distance <= best.distance) best = { name: named.name, distance };
  }
  return best.name;
}
