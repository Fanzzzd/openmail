import { Effect } from "effect";
import { useCallback } from "react";
import { isDesktop } from "../lib/platform";
import { useRunMail, withMail, type MailEnv } from "./mail";

/**
 * Copies text. The only renderer code that writes the clipboard: on the Mac it goes through the
 * main process, which keeps the text in memory in a hidden run instead of writing the system
 * clipboard.
 */
export const copyText = (text: string): Effect.Effect<void, unknown, MailEnv> =>
  isDesktop()
    ? withMail((call) => call("CopyText", { text }))
    : // The browser writes this device's clipboard, never the Mac's.
      Effect.tryPromise(() => navigator.clipboard.writeText(text));

/** `copyText` for event handlers; `done` gets whether the text was copied. */
export function useCopyText() {
  const run = useRunMail();
  return useCallback(
    (text: string, done: (copied: boolean) => void) => {
      run(
        copyText(text).pipe(
          Effect.matchCause({ onFailure: () => done(false), onSuccess: () => done(true) }),
        ),
      );
    },
    [run],
  );
}
