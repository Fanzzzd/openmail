export const ELECTRON_LICENSE_DIR: string;
export const ELECTRON_LICENSE_FILES: readonly string[];
export const ELECTRON_LICENSE_SOURCE: string;
export function electronLicenseResources(source?: string): { from: string; to: string }[];
export function missingElectronLicenses(dir: string): string[];
export function checkElectronLicenses(source?: string): void;
export function prepareElectronLicenses(options?: {
  out?: string;
  dist?: string;
  version?: string;
  download?: (version: string) => Promise<string>;
}): Promise<"prepared" | "dist" | "zip">;
