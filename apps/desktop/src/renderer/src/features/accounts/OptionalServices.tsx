import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { consentBatch, type OptionalService } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import type { Account } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import { MailClient } from "../../state/rpc";
import { Keys, MAIL_KEYS } from "../../state/keys";
import { reauthAtom } from "../../state/mutations";
import { Checkbox } from "../../ui/Checkbox";
import { buttonLink } from "../../ui/styles";

const optionalServicesAtom = (accountId: string) =>
  MailClient.query("OptionalServices", { accountId }, { reactivityKeys: [Keys.accounts] });
const switchAtom = MailClient.mutation("SetServiceEnabled");
function openOptionalServices(accountId: string) {
  window.dispatchEvent(new CustomEvent("openmail:optional-services", { detail: accountId }));
}
/** The service's grant; undefined while loading and for IMAP, which has no optional services. */
export function useServiceState(accountId: string, service: OptionalService) {
  const snapshot = useAtomValue(optionalServicesAtom(accountId));
  return AsyncResult.getOrElse(snapshot, () => []).find((grant) => grant.service === service)
    ?.state;
}
export function ServiceHint({
  accountId,
  service,
}: {
  accountId: string;
  service: OptionalService;
}) {
  const { t } = useLingui();
  const state = useServiceState(accountId, service);
  if (!state || state === "granted") return null;
  const off = {
    calendar: t`Calendar access is off for this account.`,
    contacts: t`Contacts access is off for this account.`,
    settings: t`Settings access is off for this account.`,
  };
  return state === "turnedOff" ? (
    <p className="text-footnote">
      {off[service]}{" "}
      <button type="button" className={buttonLink} onClick={() => openOptionalServices(accountId)}>
        <Trans>Turn it on in Settings</Trans>
      </button>
    </p>
  ) : (
    <button
      type="button"
      className={`text-footnote ${buttonLink}`}
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
  /** A consent that also covers services turned on earlier, waiting for the person to confirm. */
  const [pending, setPending] = useState<{
    service: OptionalService;
    others: OptionalService[];
  } | null>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  if (account.provider === "imap") return null;
  const names = {
    contacts: t`Contacts`,
    calendar: t`Calendar`,
    settings: account.provider === "gmail" ? t`Gmail Settings` : t`MailboxSettings`,
  };
  const pendingNames = pending
    ? new Intl.ListFormat(i18n.locale).format(pending.others.map((service) => names[service]))
    : "";
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="space-y-1 rounded-item outline-offset-2 outline-a11y-focus focus-visible:outline-2"
    >
      <h4 className="font-semibold text-a11y-muted">
        <Trans>Optional services</Trans>
      </h4>
      {grants.map(({ service, state }) => (
        <div key={service} className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1">{names[service]}</span>
          <span className="text-a11y-muted">
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
              className={buttonLink}
              onClick={() => {
                const others = consentBatch(grants, service).slice(1);
                if (others.length) setPending({ service, others });
                else authorize(service);
              }}
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
      {pending && (
        <p>
          <Trans>Connecting also asks for {pendingNames}.</Trans>{" "}
          <button
            type="button"
            className={buttonLink}
            onClick={() => {
              authorize(pending.service);
              setPending(null);
            }}
          >
            <Trans>Continue</Trans>
          </button>{" "}
          <button type="button" className={buttonLink} onClick={() => setPending(null)}>
            <Trans>Cancel</Trans>
          </button>
        </p>
      )}
      {authorization.waiting && (
        <p className="text-a11y-muted">
          <Trans>Finish signing in in your browser</Trans>
        </p>
      )}
      {(resultError(i18n, snapshot) ||
        resultError(i18n, authorization) ||
        resultError(i18n, result)) && (
        <output role="alert" className="block text-a11y-danger">
          {resultError(i18n, snapshot) ||
            resultError(i18n, authorization) ||
            resultError(i18n, result)}
        </output>
      )}
    </section>
  );
}
