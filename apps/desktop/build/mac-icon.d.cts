export const ICNS: "build/icon.icns";
export const ICON_COMPOSER: "build/icon.icon";
export function xcodeMajor(output: string | null): number | undefined;
export function macIconFor(output: string | null): "build/icon.icon" | "build/icon.icns";
export function macIcon(
  read?: () => string | null,
  log?: (message: string) => void,
): "build/icon.icon" | "build/icon.icns";
