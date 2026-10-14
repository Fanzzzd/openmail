export const ICNS: "build/icon.icns";
export const ICON_COMPOSER: "build/icon.icon";
export function xcodeMajor(output: string | undefined): number | undefined;
export function macIconFor(output: string | undefined): "build/icon.icon" | "build/icon.icns";
export function macIcon(
  read?: () => string | undefined,
  log?: (message: string) => void,
): "build/icon.icon" | "build/icon.icns";
