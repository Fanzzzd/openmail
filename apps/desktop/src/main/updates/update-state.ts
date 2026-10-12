import { updateVersionAllowed } from "@openmail/core";
import type { UpdateState } from "@openmail/core/schema";

let state: UpdateState = { status: "disabled" };
let generation = 0;
export const currentUpdateState = (): UpdateState => state;
/** Superseded checks/downloads must not restore an old token/channel's status. */
export function beginUpdateState(
  options: {
    reset: boolean;
    downloadedVersion: string | null;
    channel: "stable" | "latest";
  } = { reset: true, downloadedVersion: null, channel: "stable" },
): (next: UpdateState) => void {
  if (options.reset) {
    ++generation;
    state = { status: "disabled" };
  } else if (
    options.downloadedVersion &&
    updateVersionAllowed(options.channel, options.downloadedVersion)
  ) {
    state = { status: "downloaded", version: options.downloadedVersion };
  }
  return updateStateReporter();
}
export function updateStateReporter(): (next: UpdateState) => void {
  const current = generation;
  return (next) => {
    if (
      current === generation &&
      (state.status !== "downloaded" ||
        next.status === "downloading" ||
        next.status === "downloaded" ||
        next.status === "disabled")
    )
      state = next;
  };
}
