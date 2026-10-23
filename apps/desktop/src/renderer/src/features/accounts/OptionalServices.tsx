import { useAtom, useAtomValue } from "@effect/atom-react";
import { Switch } from "../../ui/Switch";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  consentBatch,
  providerCapabilities,
  type OptionalService,
  type ServiceGrant,
} from "@openmail/core/schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import type { Account } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import { canCall } from "../../lib/platform";
import { MailClient } from "../../state/rpc";
import { Keys, MAIL_KEYS } from "../../state/keys";
import { reauthAtom } from "../../state/mutations";
import { buttonLink } from "../../ui/styles";

const optionalServicesAtom = (accountId: string) =>
  MailClient.query("OptionalServices", { accountId }, { reactivityKeys: [Keys.accounts] });
const switchAtom = MailClient.mutation("SetServiceEnabled");
function openOptionalServices(accountId: string) {
  window.dispatchEvent(new CustomEvent("openmail:optional-services", { detail: accountId }));
}
/** Never resolves: the web build can't read grants, so it shows no service hints. */
const unknownServicesAtom = Atom.make(AsyncResult.initial<ServiceGrant[]>());

/**
 * The service's grant; undefined while loading, for IMAP, which has no optional
 * services, and in the web build, where the Mac's remote server refuses OptionalServices.
 */
export function useServiceState(accountId: string, service: OptionalService) {
  const snapshot = useAtomValue(
    canCall("OptionalServices") ? optionalServicesAtom(accountId) : unknownServicesAtom,
  );
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
  if (!providerCapabilities(account.provider).optionalServices) return null;
  const names = {
    contacts: t`Contacts`,
    calendar: t`Calendar`,
    settings: account.provider === "gmail" ? t`Gmail settings` : t`Outlook settings`,
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
          {state !== "granted" && (
            <>
              <span className="text-a11y-muted">
                {state === "turnedOff" ? t`Turned off` : t`Not granted`}
              </span>
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
            </>
          )}
          <Switch
            aria-label={names[service]}
            checked={state === "granted"}
            disabled={authorization.waiting || result.waiting || state === "notGranted"}
            onCheckedChange={(enabled) =>
              toggle({
                payload: { accountId: account.id, service, enabled },
                reactivityKeys: MAIL_KEYS,
              })
            }
          />
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
