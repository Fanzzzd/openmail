import { app, systemPreferences } from "electron";
import { dateRegionQuery } from "../../shared/date-region";

/**
 * The macOS region (Language & Region > Region, e.g. en-GB) and the 24-hour time switch, for
 * dates in the renderer. macOS stores the switch only when it differs from the region's clock.
 */
export function systemDateRegion(): Record<string, string> {
  const mac = process.platform === "darwin";
  const force24 = mac && systemPreferences.getUserDefault("AppleICUForce24HourTime", "boolean");
  const force12 = mac && systemPreferences.getUserDefault("AppleICUForce12HourTime", "boolean");
  return dateRegionQuery({
    region: app.getSystemLocale(),
    hourCycle: force24 ? "h23" : force12 ? "h12" : undefined,
  });
}
