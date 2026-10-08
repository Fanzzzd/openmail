import { DeviceError } from "./errors.js";

/** Reasons from local OS APIs. The caller's UI supplies the action exactly once. */
export function deviceErrorReason(error: unknown): string {
  const reason = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).trim();
  if (/^no printers (?:are )?available(?: on the network)?[.!]?$/i.test(reason))
    return "no printers are available.";
  return reason || "the operation failed.";
}

/** A DeviceError that carries the OS reason for `error`. */
export const deviceFailure = (error: unknown) =>
  new DeviceError({ message: deviceErrorReason(error) });
