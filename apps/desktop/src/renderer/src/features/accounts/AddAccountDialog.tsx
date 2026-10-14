import type { MessageDescriptor, I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronLeft, X } from "lucide-react";
import { useRef, useState } from "react";

import type { Account } from "../../../../shared/api";
import { ProviderIcon, type ProviderIconName } from "../../ui/ProviderIcon";
import { Dialog } from "../../ui/Dialog";
import { ImapStep, type ImapChoice } from "./ImapStep";
import { OAuthStep, type OAuthProvider } from "./OAuthStep";

/** Preset names that are not plain brand names. */
const PRESET_NAMES: Record<string, MessageDescriptor> = {
  qq: msg`QQ Mail`,
  "163": msg`163 Mail`,
};

type Choice = OAuthProvider | ImapChoice;

/** Brand names stay as they are; the rest are translated. */
const TILES: { id: Choice; icon: ProviderIconName; label: string | MessageDescriptor }[] = [
  { id: "gmail", icon: "gmail", label: "Gmail" },
  { id: "outlook", icon: "outlook", label: "Outlook" },
  { id: "icloud", icon: "icloud", label: "iCloud" },
  { id: "yahoo", icon: "yahoo", label: "Yahoo" },
  { id: "qq", icon: "qq", label: PRESET_NAMES.qq! },
  { id: "163", icon: "163", label: PRESET_NAMES["163"]! },
  { id: "fastmail", icon: "fastmail", label: "Fastmail" },
  { id: "custom", icon: "imap", label: msg`Other IMAP` },
];

const tileLabel = (i18n: I18n, label: string | MessageDescriptor) =>
  typeof label === "string" ? label : i18n._(label);

const isOAuth = (c: Choice): c is OAuthProvider => c === "gmail" || c === "outlook";

const IMAP_CHOICES: ReadonlySet<string> = new Set([
  "icloud",
  "yahoo",
  "qq",
  "163",
  "fastmail",
  "custom",
]);
const isImapChoice = (preset: string): preset is ImapChoice => IMAP_CHOICES.has(preset);

interface Props {
  onClose: () => void;
  onAdded: (account: Account) => void;
  /** No account yet: the dialog greets the person. Closing it leaves an empty window with Add account. */
  firstRun?: boolean;
  /**
   * An IMAP account whose password the server rejected. The dialog opens on its
   * preset with the address and stored server settings filled in, never the password.
   */
  signInAgain?: Account;
}

/**
 * Adds a mail account. Step one picks the provider; step two signs in through
 * the browser (Gmail, Outlook) or with an app password (IMAP providers).
 */
export function AddAccountDialog({ onClose, onAdded, firstRun, signInAgain }: Props) {
  const { t, i18n } = useLingui();
  const againPreset = signInAgain?.imap?.preset;
  const [choice, setChoice] = useState<Choice | null>(
    signInAgain ? (againPreset && isImapChoice(againPreset) ? againPreset : "custom") : null,
  );
  const tile = TILES.find((item) => item.id === choice);
  // Focus starts on the first provider, the step's first choice, not on Close.
  const firstTile = useRef<HTMLButtonElement>(null);

  const provider = tile ? tileLabel(i18n, tile.label) : "";
  const title = signInAgain
    ? t`Sign in again`
    : tile
      ? t`Add ${provider}`
      : firstRun
        ? t`Add your first account`
        : t`Add email account`;

  return (
    <Dialog
      aria-label={title}
      onClose={onClose}
      ownClose
      initialFocus={choice === null ? firstTile : undefined}
      className="w-[min(460px,calc(100vw-48px))] p-6"
      backdropClassName="bg-black/30 backdrop-blur-[2px]"
    >
      <header className="flex h-7 items-center gap-2">
        {tile && !signInAgain && (
          <button
            type="button"
            aria-label={t`Back`}
            onClick={() => setChoice(null)}
            className="-ml-1.5 flex size-7 items-center justify-center rounded-control text-a11y-muted hover:bg-fill-hover"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        {tile && <ProviderIcon provider={tile.icon} className="size-5 shrink-0" />}
        <h2 className="flex-1 text-headline font-semibold">{title}</h2>
        <button
          type="button"
          aria-label={t`Close`}
          onClick={onClose}
          className="-mr-1.5 flex size-7 items-center justify-center rounded-control text-a11y-muted hover:bg-fill-hover"
        >
          <X className="size-4" />
        </button>
      </header>

      {choice === null && (
        <>
          <p className="mt-1.5 text-a11y-muted">
            {firstRun ? (
              <Trans>
                Welcome to OpenMail. Choose your email provider. Your credentials stay on this
                computer.
              </Trans>
            ) : (
              <Trans>Choose your email provider.</Trans>
            )}
          </p>
          <div className="mt-5 grid grid-cols-4 gap-2">
            {TILES.map((item, index) => (
              <button
                key={item.id}
                ref={index === 0 ? firstTile : undefined}
                type="button"
                aria-label={tileLabel(i18n, item.label)}
                onClick={() => setChoice(item.id)}
                className="flex flex-col items-center gap-2 rounded-card px-1 py-4 ring-1 ring-edge transition-colors hover:bg-fill-hover active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-a11y-focus motion-reduce:transition-none"
              >
                <ProviderIcon provider={item.icon} className="size-8" />
                <span className="text-footnote text-neutral-700 dark:text-neutral-300">
                  {tileLabel(i18n, item.label)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {choice !== null && isOAuth(choice) && (
        <OAuthStep key={choice} provider={choice} onAdded={onAdded} />
      )}
      {choice !== null && !isOAuth(choice) && (
        <ImapStep
          key={choice}
          preset={choice}
          onAdded={onAdded}
          {...(signInAgain ? { signInAgain } : {})}
        />
      )}
    </Dialog>
  );
}
