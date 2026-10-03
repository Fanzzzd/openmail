import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OptionalService } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";
import type { Account } from "../../../shared/api";
import { resultError } from "../errors";
import { MailClient } from "../rpc";
import { Keys, MAIL_KEYS } from "../state/keys";
import { reauthAtom } from "../state/mutations";
import { Checkbox } from "./ui/Checkbox";

export const optionalServicesAtom = (accountId: string) =>
  MailClient.query("OptionalServices", { accountId }, { reactivityKeys: [Keys.accounts] });
const switchAtom = MailClient.mutation("SetServiceEnabled");
export function openOptionalServices(accountId: string) {
  window.dispatchEvent(new CustomEvent("openmail:optional-services", { detail: accountId }));
}
export function ServiceHint({
  accountId,
  service,
}: {
  accountId: string;
  service: OptionalService;
}) {
  const snapshot = useAtomValue(optionalServicesAtom(accountId));
  const grants = AsyncResult.getOrElse(snapshot, () => []);
  if (
    snapshot._tag !== "Success" ||
    !grants.some((grant) => grant.service === service && grant.state !== "granted")
  )
    return null;
  return (
    <button
      type="button"
      className="text-xs text-a11y-accent"
      onClick={() => openOptionalServices(accountId)}
    >
      <Trans>Connect this service in Settings → Accounts → Optional services.</Trans>
    </button>
  );
}
export function OptionalServices({
  account,
  focus = false,
}: {
  account: Account;
  focus?: boolean;
}) {
  const { t, i18n } = useLingui();
  const ref = useRef<HTMLElement>(null);
  const snapshot = useAtomValue(optionalServicesAtom(account.id));
  const grants = AsyncResult.getOrElse(snapshot, () => []);
  const [authorization, authorize] = useAtom(reauthAtom(account.id));
  const [result, toggle] = useAtom(switchAtom);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  if (account.provider === "imap") return null;
  const names = {
    contacts: t`Contacts`,
    calendar: t`Calendar`,
    settings: account.provider === "gmail" ? t`Gmail Settings` : t`MailboxSettings`,
  };
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="w-full space-y-2 border-t border-black/5 pt-2 dark:border-white/5"
    >
      <h4 className="font-medium">
        <Trans>Optional services</Trans>
      </h4>
      {grants.map(({ service, state }) => (
        <div key={service} className="flex items-center gap-3">
          <span className="flex-1">{names[service]}</span>
          <span className="text-xs text-a11y-muted">
            {state === "granted"
              ? t`Granted`
              : state === "turnedOff"
                ? t`Turned off`
                : t`Not granted`}
          </span>
          {state !== "granted" && (
            <button
              type="button"
              disabled={authorization.waiting || result.waiting || account.enabled === false}
              className="text-a11y-accent"
              onClick={() => authorize(service)}
            >
              <Trans>Connect</Trans>
            </button>
          )}
          <label
            htmlFor={`service-off-${account.id}-${service}`}
            className="flex items-center gap-2"
          >
            <Checkbox
              id={`service-off-${account.id}-${service}`}
              checked={state === "turnedOff"}
              disabled={authorization.waiting || result.waiting || state === "notGranted"}
              onCheckedChange={(off) =>
                toggle({
                  payload: { accountId: account.id, service, enabled: !off },
                  reactivityKeys: MAIL_KEYS,
                })
              }
            />
            <Trans>Turn off</Trans>
          </label>
        </div>
      ))}
      {authorization.waiting && (
        <p className="text-xs text-a11y-muted">
          <Trans>Finish signing in in your browser</Trans>
        </p>
      )}
      {(resultError(i18n, snapshot) ||
        resultError(i18n, authorization) ||
        resultError(i18n, result)) && (
        <output role="alert" className="text-a11y-danger">
          {resultError(i18n, snapshot) ||
            resultError(i18n, authorization) ||
            resultError(i18n, result)}
        </output>
      )}
    </section>
  );
}
