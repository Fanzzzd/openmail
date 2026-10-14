export const ELECTRON_LICENSE_DIR: string;
export const ELECTRON_LICENSE_FILES: readonly string[];
export function electronLicenseResources(dist?: string): { from: string; to: string }[];
export function missingElectronLicenses(dir: string): string[];
export function checkElectronLicenses(dist?: string): void;
