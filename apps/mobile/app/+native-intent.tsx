import { readMobileConfig } from "../src/platform/config";
import { oauthSystemPath } from "../src/oauth-intent";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return oauthSystemPath(path, readMobileConfig());
  } catch {
    return "/";
  }
}
