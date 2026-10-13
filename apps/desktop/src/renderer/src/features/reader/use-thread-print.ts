import type { Notify } from "./notify";
import { useLingui } from "@lingui/react/macro";
import { printThread, useRunMail } from "../../state/mail";
import { Effect } from "effect";
import { causeText } from "../../lib/errors";

/** Prints a thread or one message of it, or saves it as PDF, reporting failures. */
export function useThreadPrint(notify: Notify) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  return (id: string, pdf: boolean, only?: string) =>
    run(
      printThread({
        id,
        ...(only ? { only } : {}),
        pdf,
        headings: { from: t`From`, to: t`To`, cc: t`Cc`, date: t`Date` },
        locale: i18n.locale,
      }).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            notify({
              text: pdf ? t`Couldn't save the PDF: ${reason}` : t`Couldn't print: ${reason}`,
              tone: "error",
            });
          },
          onSuccess: (done) => {
            if (done && pdf) notify({ text: t`Saved as PDF` });
          },
        }),
      ),
    );
}
