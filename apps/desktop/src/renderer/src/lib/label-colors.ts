type Rgb = readonly [number, number, number];
const lightSurfaces: readonly Rgb[] = [
  [255, 255, 255],
  [245, 245, 245],
  [237, 237, 237],
];
const darkSurfaces: readonly Rgb[] = [
  [23, 23, 23],
  [38, 38, 38],
  [48, 48, 48],
];
const alpha = 0.2;
function luminance(rgb: Rgb) {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
}
function mix(color: Rgb, surface: Rgb, amount: number): Rgb {
  const channel = (index: 0 | 1 | 2) =>
    Math.round(color[index] * amount + surface[index] * (1 - amount));
  return [channel(0), channel(1), channel(2)];
}
function hex(rgb: Rgb) {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
function readable(color: Rgb, surfaces: readonly Rgb[], target: Rgb) {
  const backgrounds = surfaces.map((surface) => luminance(mix(color, surface, alpha)));
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(target, color, step / 100);
    const foreground = luminance(candidate);
    if (
      backgrounds.every(
        (background) =>
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >=
          4.6,
      )
    )
      return hex(candidate);
  }
  return hex(target);
}

/** Adapt a saved label color at the CSS boundary; keep its hue and translucent tint. */
export function labelChipColors(value: string) {
  const color = /^#[\da-f]{6}$/i.test(value) ? value : "#737373";
  const rgb: Rgb = [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
  return {
    backgroundColor: `${color}33`,
    "--label-text-light": readable(rgb, lightSurfaces, [0, 0, 0]),
    "--label-text-dark": readable(rgb, darkSurfaces, [255, 255, 255]),
  };
}
