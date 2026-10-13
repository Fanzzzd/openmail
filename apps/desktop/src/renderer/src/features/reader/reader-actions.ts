import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { causeText } from "../../lib/errors";
import { useRunMail, withMail } from "../../state/mail";
import type { Notify } from "./notify";

export function useSaveMessage(notify: Notify) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  return (id: string) =>
    run(
      withMail((call) => call("SaveMessage", { id })).pipe(
        Effect.matchCause({
          onSuccess: (saved) => {
            if (saved) notify({ text: t`Saved as EML` });
          },
          onFailure: (cause) => notify({ text: causeText(i18n, cause), tone: "error" }),
        }),
      ),
    );
}
