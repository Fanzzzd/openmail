import { useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import type { Address } from "../../../../shared/api";
import { canCall } from "../../lib/platform";
import { useRunMail, withMail } from "../../state/mail";
import { appleContactIdentifierAtom, appleContactsStatusAtom } from "../../state/queries";
import { MenuItem } from "../../ui/Menu";

/** Every action is a deliberate click; rendering a menu never requests permission. */
export function AppleContactActions({ address }: { address: Address }) {
  // Apple Contacts are on the Mac; the remote server refuses the lookup.
  return canCall("AppleContactIdentifier") ? <AppleContactItems address={address} /> : null;
}

function AppleContactItems({ address }: { address: Address }) {
  const { t } = useLingui();
  const run = useRunMail();
  const status =
    AsyncResult.getOrElse(useAtomValue(appleContactsStatusAtom), () => null)?.status ?? null;
  const identifier = AsyncResult.getOrElse(
    useAtomValue(appleContactIdentifierAtom(address.address)),
    () => null,
  );
  if (status === null || status === "unsupported") return null;
  return identifier ? (
    <MenuItem
      onClick={() =>
        run(withMail((call) => call("OpenAppleContact", { address: address.address })))
      }
    >{t`Open in Contacts`}</MenuItem>
  ) : (
    <MenuItem
      onClick={() => run(withMail((call) => call("AddAppleContact", { contact: address })))}
    >{t`Add to Contacts`}</MenuItem>
  );
}
