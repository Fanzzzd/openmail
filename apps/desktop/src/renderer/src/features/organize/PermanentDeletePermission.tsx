import { useAtom } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { resultError } from "../../lib/errors";
import { canCall } from "../../lib/platform";
import { SignInAgainOnMac } from "../../ui/SignInAgainOnMac";
import { authorizePermanentDeleteAtom } from "../../state/mutations";
import { Alert, AlertCancel } from "../../ui/Dialog";
import { formButton } from "../../ui/form-styles";

/** Consent grants permission only. Deletion always requires a new confirmation. */
export function PermanentDeletePermission({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const [result, authorize] = useAtom(authorizePermanentDeleteAtom(accountId), {
    mode: "promiseExit",
  });
  const email = accountId.replace(/^gmail:/, "");
  return (
    <Alert
      open
      onOpenChange={(open) => {
        if (!open && !result.waiting) onClose();
      }}
      title={t`Allow permanent deletion for ${email}?`}
      description={
        <>
          {t`This permission lets OpenMail permanently delete mail in this Gmail account. Google will ask for your consent. After granting it, confirm the deletion again.`}
          {resultError(i18n, result) && (
            <span role="alert" className="mt-2 block text-orange-700 dark:text-orange-400">
              {resultError(i18n, result)}
            </span>
          )}
        </>
      }
    >
      <AlertCancel disabled={result.waiting}>{t`Cancel`}</AlertCancel>
      {canCall("Reauth") ? (
        <button
          type="button"
          className={formButton}
          disabled={result.waiting}
          onClick={async () => {
            const exit = await authorize();
            if (exit._tag === "Success") onClose();
          }}
        >{t`Authorize permanent deletion`}</button>
      ) : (
        <SignInAgainOnMac className="self-center" />
      )}
    </Alert>
  );
}
