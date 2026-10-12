import { expect, it } from "vitest";
import { beginUpdateState, currentUpdateState, updateStateReporter } from "./update-state";

it("changing update configuration invalidates checks and late downloads from the old configuration", () => {
  const old = beginUpdateState();
  old({ status: "downloading", version: "2.0.0-beta.1" });
  const fresh = beginUpdateState();
  old({ status: "downloaded", version: "2.0.0-beta.1" });
  expect(currentUpdateState()).toEqual({ status: "disabled" });
  fresh({ status: "available", version: "2.0.0" });
  expect(currentUpdateState()).toEqual({ status: "available", version: "2.0.0" });
  const manual = updateStateReporter();
  manual({ status: "downloaded", version: "2.0.0" });
  fresh({ status: "checking" });
  fresh({ status: "upToDate" });
  expect(currentUpdateState()).toEqual({ status: "downloaded", version: "2.0.0" });
  beginUpdateState()({ status: "disabled" });
  manual({ status: "downloaded", version: "2.0.0" });
  expect(currentUpdateState()).toEqual({ status: "disabled" });
});

it("download preference restarts keep or seed the ready state while token/channel restarts invalidate it", () => {
  beginUpdateState()({ status: "downloaded", version: "2.0.0" });
  const prefs = beginUpdateState({ reset: false, downloadedVersion: "2.0.0", channel: "stable" });
  expect(currentUpdateState()).toEqual({ status: "downloaded", version: "2.0.0" });
  prefs({ status: "checking" });
  expect(currentUpdateState()).toEqual({ status: "downloaded", version: "2.0.0" });
  beginUpdateState();
  beginUpdateState({ reset: false, downloadedVersion: "2.0.0", channel: "stable" });
  expect(currentUpdateState()).toEqual({ status: "downloaded", version: "2.0.0" });
  beginUpdateState({ reset: true, downloadedVersion: "2.0.0", channel: "stable" });
  expect(currentUpdateState()).toEqual({ status: "disabled" });
  prefs({ status: "downloaded", version: "2.0.0" });
  expect(currentUpdateState()).toEqual({ status: "disabled" });
  beginUpdateState({ reset: false, downloadedVersion: "2.1.0-beta.1", channel: "stable" });
  expect(currentUpdateState()).toEqual({ status: "disabled" });
});
