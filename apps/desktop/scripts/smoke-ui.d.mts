export function smokeClickExpression(selector: string, ready?: string): string;
export function isBlockedSmokeImage(source: string | undefined, text: string): boolean;
export function smokeEnvironment(
  base: Record<string, string | undefined>,
  directory: string,
  network?: boolean,
  windows?: "hidden" | "background",
): Record<string, string | undefined>;
export const VISIBLE_WINDOWS_OK: "OPENMAIL_VISIBLE_WINDOWS_OK";
export function visibleWindowsRefusal(
  env: Record<string, string | undefined>,
  harness: string,
  reason: string,
): string | null;
export function requireVisibleWindows(harness: string, reason: string): void;
export function missingBuild(desktop: string, exists?: (file: string) => boolean): string | null;
export function requireBuild(): void;
