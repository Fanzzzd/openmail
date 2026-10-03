import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import type { Message } from "@openmail/core/schema";
import { linkHint } from "@openmail/core/schema";
import { useRunMail, withMail } from "../state/mail";
import { Dialog } from "./ui/Dialog";

export function UnsubscribeButton({ message }: { message: Message }) {
  const { t } = useLingui();
  const run = useRunMail();
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const target = message.security?.unsubscribe;
  if (!target) return null;
  const proceed = () => {
    setStatus("pending");
    run(
      withMail((call) =>
        target.kind === "post"
          ? call("Unsubscribe", { messageId: message.id })
          : call("OpenMailLink", { url: target.url }),
      ).pipe(
        Effect.match({
          onSuccess: () => {
            setStatus("done");
            setConfirm(false);
          },
          onFailure: () => setStatus("failed"),
        }),
      ),
    );
  };
  return (
    <>
      <button
        type="button"
        className="mt-2 text-a11y-accent"
        disabled={status === "done"}
        onClick={() => setConfirm(true)}
      >{t`Unsubscribe`}</button>
      {confirm && (
        <Dialog
          aria-label={t`Unsubscribe?`}
          onClose={status === "pending" ? undefined : () => setConfirm(false)}
          className="w-[min(90vw,480px)] space-y-4 p-5"
        >
          <p>
            {target.kind === "post"
              ? t`Send an unsubscribe request to this address?`
              : t`Review an unsubscribe email before sending?`}
          </p>
          <p className="font-mono break-all">{linkHint(target.url)}</p>
          {status === "failed" && <p role="alert">{t`Unsubscribe failed. Try again later.`}</p>}
          <div className="flex justify-end gap-4">
            <button
              type="button"
              disabled={status === "pending"}
              onClick={() => setConfirm(false)}
            >{t`Cancel`}</button>
            <button
              type="button"
              disabled={status === "pending"}
              onClick={proceed}
            >{t`Continue`}</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
