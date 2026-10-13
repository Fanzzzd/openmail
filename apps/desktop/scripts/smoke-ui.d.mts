export function smokeClickExpression(selector: string, ready?: string): string;
export function isBlockedSmokeImage(source: string | undefined, text: string): boolean;
export function smokeEnvironment(
  base: Record<string, string | undefined>,
  directory: string,
  network?: boolean,
): Record<string, string | undefined>;
