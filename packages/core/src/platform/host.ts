import { Context, DateTime } from "effect";

/** Facts about the machine core runs on. The platform Layer supplies them; core reads no globals for them. */
export interface Host {
  /**
   * The OS time zone as an IANA name, such as "Asia/Shanghai". A function, because the person
   * can change the zone or travel while the app runs.
   */
  readonly timeZone: () => string;
  /** The OS as Node names it ("darwin", "linux", "win32"), or "ios", "android", "unknown". */
  readonly os: string;
  /** The CPU architecture of the running build ("arm64", "x64"), or "unknown". */
  readonly arch: string;
}

/** Defaults to UTC, so tests and platforms without a host Layer stay deterministic. */
export const PlatformHost = Context.Reference<Host>("openmail/PlatformHost", {
  defaultValue: () => ({ timeZone: () => "UTC", os: "unknown", arch: "unknown" }),
});

/**
 * Whether on-device models (semantic search, image vectors) can load here. ONNX Runtime 1.30.0
 * ships no macOS x64 binding (docs/release.md), so an Intel Mac, or an x64 build under
 * Rosetta, never downloads the models or starts the inference process.
 */
export const onDeviceModelsSupported = (host: Host): boolean =>
  !(host.os === "darwin" && host.arch !== "arm64");

const zoned = (ms: number, timeZone: string) => {
  try {
    return DateTime.makeZonedUnsafe(ms, { timeZone });
  } catch {
    return DateTime.makeZonedUnsafe(ms, { timeZone: "UTC" });
  }
};

/**
 * An instant as ISO 8601 local time with its UTC offset and without milliseconds, such as
 * "2026-10-15T09:00:00+08:00". Every time an agent or model reads uses this one format.
 */
export const localIso = (ms: number, timeZone: string): string =>
  DateTime.formatIsoOffset(zoned(ms, timeZone)).replace(/\.\d{3}(?=[+-])/, "");

/** The local calendar day of an instant, as "YYYY-MM-DD". */
export const localDay = (ms: number, timeZone: string): string =>
  localIso(ms, timeZone).slice(0, 10);

/** One prompt line with the current local time, its offset and the IANA zone. */
export const nowLine = (ms: number, timeZone: string): string =>
  `The current local time is ${localIso(ms, timeZone)} (${timeZone}).`;
