import { InvalidInput, meetingUrl } from "@openmail/core/schema";
import { Effect } from "effect";
import { shell } from "electron";

/** Renderer URLs are untrusted; validate again before crossing into the system browser. */
export const openMeeting = (value: string) => {
  const url = meetingUrl(value);
  return url
    ? Effect.promise(() => shell.openExternal(url))
    : Effect.fail(new InvalidInput({ message: "This meeting link is not supported." }));
};
