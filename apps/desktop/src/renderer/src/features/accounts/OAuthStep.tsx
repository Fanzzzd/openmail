import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Exit } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { ExternalLink } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Account } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import { clearClientAtom, connectAtom, saveClientAtom } from "../../state/mutations";
import { clientSetupAtom } from "../../state/queries";
import { Disclosure } from "../../ui/Disclosure";
import { Actions, ErrorLine, Field, PrimaryButton, SecondaryButton } from "./AccountFormParts";

/**
 * Google has not finished verifying OpenMail's built-in client, so its consent
 * flow shows an unverified-app warning first. Set to false once verification lands.
 */
export const GOOGLE_BUILT_IN_UNVERIFIED: boolean = true;

export type OAuthProvider = "gmail" | "outlook";

// Gmail and Outlook

const OAUTH_COPY: Record<OAuthProvider, { name: string; doc: string }> = {
  gmail: { name: "Google", doc: "https://openmail-docs.vercel.app/docs/own-oauth-client#google" },
  outlook: {
    name: "Microsoft",
    doc: "https://openmail-docs.vercel.app/docs/own-oauth-client#microsoft",
  },
};

export function OAuthStep({
  provider,
  onAdded,
}: {
  provider: OAuthProvider;
  onAdded: (account: Account) => void;
}) {
  const setup = AsyncResult.getOrElse(useAtomValue(clientSetupAtom), () => null);
  const [signIn, runSignIn] = useAtom(connectAtom(provider), { mode: "promiseExit" });
  // Interrupting the call reaches the main process, which closes the loopback server.
  const control = useAtomSet(connectAtom(provider));
  const { i18n } = useLingui();
  // Cancel interrupts the sign-in; that is not an error to show.
  const signInError = AsyncResult.isInterrupted(signIn) ? null : resultError(i18n, signIn);
  const { name } = OAUTH_COPY[provider];

  const signInNow = async () => {
    const exit = await runSignIn({ provider });
    if (Exit.isSuccess(exit)) onAdded(exit.value);
  };

  if (!setup)
    return (
      <p className="mt-5 text-a11y-muted">
        <Trans>Loading settings…</Trans>
      </p>
    );
  const gmail = provider === "gmail";
  const active = gmail ? setup.googleClient : setup.microsoftClient;
  const configured = active !== "none";
  const builtIn = gmail ? setup.googleBuiltIn : setup.microsoftBuiltIn;

  // No built-in or saved client: the person registers one first.
  if (!configured)
    return (
      <ClientForm provider={provider} autoFocus>
        {provider === "gmail" ? (
          <Trans>
            OpenMail signs in with an OAuth client you register yourself. First enter the OAuth
            client you created in Google Cloud, with the Desktop app type.
          </Trans>
        ) : (
          <Trans>
            OpenMail signs in with an OAuth client you register yourself. First enter the app you
            registered in Azure, with the Mobile and desktop applications type. Only personal
            outlook.com and Hotmail accounts are supported.
          </Trans>
        )}{" "}
        <SetupLink provider={provider} />
      </ClientForm>
    );

  return (
    <div className="mt-4">
      <p className="text-a11y-muted">
        {signIn.waiting ? (
          <Trans>Finish signing in in your browser, then come back here.</Trans>
        ) : provider === "gmail" ? (
          <Trans>
            Sign in with your Google account in the browser. OpenMail keeps the sign-in token in
            this computer's keychain.
          </Trans>
        ) : (
          <Trans>
            Sign in with your personal Microsoft account (outlook.com or Hotmail) in the browser.
            OpenMail keeps the sign-in token in this computer's keychain.
          </Trans>
        )}
      </p>
      {gmail && active === "builtIn" && GOOGLE_BUILT_IN_UNVERIFIED && (
        <p className="mt-2 text-a11y-muted">
          <Trans>
            Google shows a warning that it hasn't verified OpenMail yet. Choose Advanced, then
            continue to OpenMail.
          </Trans>
        </p>
      )}
      <p className="mt-2 text-footnote text-a11y-muted">
        {active === "own" ? (
          <Trans>New sign-ins use your own OAuth client.</Trans>
        ) : (
          <Trans>New sign-ins use OpenMail's built-in client.</Trans>
        )}
      </p>
      {active === "own" && builtIn && <UseBuiltIn provider={provider} />}
      {signInError && <ErrorLine text={signInError} />}
      <Actions>
        {signIn.waiting && (
          <SecondaryButton onClick={() => control(Atom.Interrupt)}>
            <Trans>Cancel</Trans>
          </SecondaryButton>
        )}
        <PrimaryButton disabled={signIn.waiting} onClick={() => void signInNow()}>
          {signIn.waiting ? (
            <Trans>Waiting for sign-in…</Trans>
          ) : (
            <Trans>Sign in with {name}</Trans>
          )}
        </PrimaryButton>
      </Actions>
      <Disclosure
        className="mt-4"
        summaryClassName="text-footnote text-a11y-muted"
        summary={
          builtIn ? (
            <Trans>Use your own OAuth client</Trans>
          ) : (
            <Trans>Change your OAuth client</Trans>
          )
        }
      >
        <ClientForm provider={provider}>
          {builtIn ? (
            <Trans>
              Enter an OAuth client you registered yourself. New sign-ins use it instead of the
              built-in client.
            </Trans>
          ) : (
            <Trans>
              Enter a different OAuth client you registered yourself. New sign-ins use it.
            </Trans>
          )}{" "}
          <SetupLink provider={provider} />
        </ClientForm>
      </Disclosure>
    </div>
  );
}

/** The docs page with the steps to register a client for this provider. */
function SetupLink({ provider }: { provider: OAuthProvider }) {
  return (
    <a
      href={OAUTH_COPY[provider].doc}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-a11y-accent hover:underline dark:text-blue-400"
    >
      {provider === "gmail" ? (
        <Trans>How to register a Google OAuth client</Trans>
      ) : (
        <Trans>How to register a Microsoft app</Trans>
      )}
      <ExternalLink className="size-3" />
    </a>
  );
}

/** Drops the person's own client from config.json. Accounts keep the client that signed them in. */
function UseBuiltIn({ provider }: { provider: OAuthProvider }) {
  const { i18n } = useLingui();
  const [clear, runClear] = useAtom(clearClientAtom);
  const clearError = resultError(i18n, clear);
  return (
    <>
      <p className="mt-1 text-footnote text-a11y-muted">
        <Trans>Accounts you already added keep the client they signed in with.</Trans>{" "}
        <button
          type="button"
          disabled={clear.waiting}
          onClick={() => runClear(provider)}
          className="text-a11y-accent hover:underline disabled:opacity-40 dark:text-blue-400"
        >
          <Trans>Use the built-in client</Trans>
        </button>
      </p>
      {clearError && <ErrorLine text={clearError} />}
    </>
  );
}

/** The OAuth client fields, saved to config.json through the main process. */
function ClientForm({
  provider,
  autoFocus,
  children,
}: {
  provider: OAuthProvider;
  autoFocus?: boolean;
  children: ReactNode;
}) {
  const { t, i18n } = useLingui();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saveClient, runSaveClient] = useAtom(saveClientAtom);
  const saveError = resultError(i18n, saveClient);
  const ready = clientId.trim() && (provider === "outlook" || clientSecret.trim());
  const { name } = OAUTH_COPY[provider];
  return (
    <form
      aria-label={t`${name} client`}
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        runSaveClient(
          provider === "gmail"
            ? { provider, clientId: clientId.trim(), clientSecret: clientSecret.trim() }
            : { provider, clientId: clientId.trim() },
        );
      }}
    >
      <p className="text-a11y-muted">{children}</p>
      <Field
        label={provider === "gmail" ? t`Client ID` : t`Application (client) ID`}
        value={clientId}
        onChange={setClientId}
        autoFocus={autoFocus}
      />
      {provider === "gmail" && (
        <Field label={t`Client secret`} value={clientSecret} onChange={setClientSecret} password />
      )}
      {saveError && <ErrorLine text={saveError} />}
      {saveClient._tag === "Success" && (
        <output className="mt-3 block text-footnote text-a11y-muted">
          <Trans>Saved. New sign-ins use this client.</Trans>
        </output>
      )}
      <Actions>
        <PrimaryButton disabled={!ready || saveClient.waiting}>
          {saveClient.waiting ? <Trans context="in progress">Saving…</Trans> : <Trans>Save</Trans>}
        </PrimaryButton>
      </Actions>
    </form>
  );
}
