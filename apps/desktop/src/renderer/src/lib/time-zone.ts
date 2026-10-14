/**
 * The IANA zone this renderer shows times in: its own Intl zone. Core takes the zone as an
 * argument and never reads it, so the renderer passes this to core's date helpers. In the web
 * build it is the remote device's zone.
 */
export const localTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
