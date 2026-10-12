import { InvalidInput, meetingUrl } from "@openmail/core/schema";
import { Effect } from "effect";
import { openExternal } from "../security/external";

/** Renderer URLs are untrusted; validate again before crossing into the system browser. */
export const openMeeting = (value: string, clean = true) => {
  const url = meetingUrl(value);
  return url
    ? Effect.promise(() => openExternal(url, clean))
    : Effect.fail(new InvalidInput({ message: "This meeting link is not supported." }));
};
