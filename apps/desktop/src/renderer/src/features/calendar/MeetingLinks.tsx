import { useLingui } from "@lingui/react/macro";
import { meetingLinks } from "@openmail/core/schema";
import { Effect } from "effect";
import { useState } from "react";
import { causeText } from "../../lib/errors";
import { useRunMail, withMail } from "../../state/mail";

export function MeetingLinks({ sources }: { sources: readonly string[] }) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const [error, setError] = useState<string | null>(null);
  const links = meetingLinks(...sources);
  if (!links.length) return null;
  return (
    <div className="my-2 flex flex-wrap items-center gap-3">
      {links.map((url) => (
        <button
          key={url}
          type="button"
          title={url}
          className="max-w-full truncate rounded border border-blue-300 px-3 py-1 text-a11y-accent dark:text-blue-400"
          onClick={() =>
            run(
              withMail((call) => call("OpenMeeting", { url })).pipe(
                Effect.matchCause({
                  onFailure: (cause) => setError(causeText(i18n, cause)),
                  onSuccess: () => setError(null),
                }),
              ),
            )
          }
        >
          {t`Join meeting`} · {new URL(url).hostname}
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
