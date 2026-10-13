import { Effect } from "effect";
import { useEffect, useState } from "react";
import type { DefaultClientStatus } from "../../../../shared/desktop";
import { useRunMail, withMail } from "../../state/mail";

/** Whether OpenMail handles mailto: links, and the request to make it. */
export function useDefaultMailClient() {
  const run = useRunMail();
  const [status, setStatus] = useState<DefaultClientStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    run(
      withMail((call) => call("DefaultMailClient", undefined)).pipe(
        Effect.tap((value) => Effect.sync(() => setStatus(value))),
      ),
    );
  }, [run]);
  const become = () => {
    setBusy(true);
    setFailed(false);
    run(
      withMail((call) => call("BecomeDefaultMailClient", undefined)).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            setStatus((current) => current && { ...current, isDefault: value });
            setFailed(!value);
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  return { status, isDefault: status?.isDefault ?? false, busy, failed, become };
}
