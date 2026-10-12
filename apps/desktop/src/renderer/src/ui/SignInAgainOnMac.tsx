import { Trans } from "@lingui/react/macro";

/**
 * Stands in for a "Sign in again" button in the web build. Signing in opens
 * the provider's page in the Mac's browser and stores the token in its
 * keychain, so the remote server refuses Reauth and Connect.
 */
export function SignInAgainOnMac({ className = "" }: { className?: string }) {
  return (
    <span className={`shrink-0 whitespace-nowrap ${className}`}>
      <Trans>Sign in again on your Mac</Trans>
    </span>
  );
}
