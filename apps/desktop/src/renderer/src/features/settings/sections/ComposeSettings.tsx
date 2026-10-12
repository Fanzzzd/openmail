import { AppleContactsSettings } from "./AppleContactsSettings";
import { SignatureSettings } from "./SignatureSettings";
import { TemplateSettings } from "./TemplateSettings";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_PREFS,
  UNDO_SEND_SECONDS,
  COMPOSE_FONT_FAMILIES,
  COMPOSE_FONT_SIZES,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";

import type { Account } from "../../../../../shared/api";
import { Keys } from "../../../state/keys";
import { setContactHiddenAtom, setPrefsAtom } from "../../../state/mutations";
import { accountsAtom, sendAsAtom, hiddenContactsAtom, prefsAtom } from "../../../state/queries";
import { Select } from "../../../ui/Select";
import { Checkbox } from "../../../ui/Checkbox";
import { settingsBox, settingsHeading } from "../../../ui/form-styles";
import { SegmentedControl } from "../../../ui/SegmentedControl";

/** Settings > Compose: undo send, signatures, templates, hidden recipients. */
export function ComposeSettings() {
  return (
    <div className="space-y-6">
      <DefaultFrom />
      <ComposeAppearance />
      <ReplyFrom />
      <RecipientAddresses />
      <AppleContactsSettings />
      <QuoteSelection />
      <UndoSend />
      <Templates />
      <HiddenContacts />
    </div>
  );
}

function RecipientAddresses() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <section>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={prefs?.showFullRecipientAddresses ?? false}
          onCheckedChange={(showFullRecipientAddresses) =>
            setPrefs({
              payload: { patch: { showFullRecipientAddresses } },
              reactivityKeys: [Keys.prefs],
            })
          }
        />
        <span>{t`Show full email addresses in recipient fields`}</span>
      </label>
    </section>
  );
}

function UndoSend() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <section>
      <h3 className={settingsHeading}>
        <Trans>Undo Send</Trans>
      </h3>
      <SegmentedControl
        aria-label={t`Undo send delay`}
        value={prefs?.undoSendSeconds ?? null}
        options={UNDO_SEND_SECONDS.map((seconds) => ({
          value: seconds,
          label: seconds === 0 ? t`Off` : plural(seconds, { one: "# second", other: "# seconds" }),
        }))}
        onValueChange={(seconds) =>
          setPrefs({
            payload: { patch: { undoSendSeconds: seconds } },
            reactivityKeys: [Keys.prefs],
          })
        }
      />
      <p className="mt-2 text-a11y-muted">
        <Trans>
          After you click Send, the message waits this long. You can undo it until then.
        </Trans>
      </p>
    </section>
  );
}

export function Signatures({ accounts }: { accounts: readonly Account[] }) {
  return <SignatureSettings accounts={accounts} />;
}
function Templates() {
  return <TemplateSettings />;
}

function HiddenContacts() {
  const hidden = AsyncResult.getOrElse(useAtomValue(hiddenContactsAtom), () => []);
  const setHidden = useAtomSet(setContactHiddenAtom);
  if (hidden.length === 0) return null;
  return (
    <section>
      <h3 className={settingsHeading}>
        <Trans>Addresses no longer suggested</Trans>
      </h3>
      <ul className={`${settingsBox} divide-y divide-black/[0.07] dark:divide-white/[0.08]`}>
        {hidden.map((address) => (
          <li key={address} className="flex items-center gap-3 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">{address}</span>
            <button
              type="button"
              onClick={() =>
                setHidden({
                  payload: { address, hidden: false },
                  reactivityKeys: [Keys.contacts],
                })
              }
              className="h-7 shrink-0 rounded-md px-2.5 text-a11y-accent hover:bg-blue-500/10 dark:text-blue-400"
            >
              <Trans>Restore</Trans>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const senderKey = (sender: { accountId: string; address: string }) =>
  JSON.stringify([sender.accountId, sender.address]);

function DefaultFrom() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const aliases = AsyncResult.getOrElse(useAtomValue(sendAsAtom), () => []);
  const setPrefs = useAtomSet(setPrefsAtom);
  const senders = accounts
    .filter((a) => a.enabled !== false)
    .flatMap((a) => [
      { accountId: a.id, address: a.email },
      ...aliases.filter(
        (s) =>
          a.provider === "gmail" &&
          s.accountId === a.id &&
          s.address.toLowerCase() !== a.email.toLowerCase(),
      ),
    ]);
  const fixed = prefs.defaultFrom;
  return (
    <section>
      <h3 className={settingsHeading}>{t`Default From address`}</h3>
      <Select
        aria-label={t`Default From address`}
        value={fixed ? senderKey(fixed) : "view"}
        options={[
          { value: "view", label: t`Use the current account` },
          ...senders.map((s) => ({
            value: senderKey(s),
            label: `${accounts.find((a) => a.id === s.accountId)?.description?.trim() || s.address}${accounts.find((a) => a.id === s.accountId)?.description?.trim() ? ` (${s.address})` : ""}`,
          })),
        ]}
        onValueChange={(value) => {
          const sender = senders.find((s) => senderKey(s) === value);
          setPrefs({
            payload: {
              patch: {
                defaultFrom: sender
                  ? { accountId: sender.accountId, address: sender.address }
                  : null,
              },
            },
            reactivityKeys: [Keys.prefs],
          });
        }}
      />
    </section>
  );
}

function QuoteSelection() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <section>
      <h3 className={settingsHeading}>{t`Quote selected text`}</h3>
      <Select
        aria-label={t`Quote selected text`}
        value={prefs.quoteSelection}
        options={[
          { value: "ask", label: t`Ask each time` },
          { value: "always", label: t`Always use selection` },
          { value: "never", label: t`Always quote the whole message` },
        ]}
        onValueChange={(quoteSelection) =>
          setPrefs({ payload: { patch: { quoteSelection } }, reactivityKeys: [Keys.prefs] })
        }
      />
    </section>
  );
}

function ComposeAppearance() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  const save = (patch: Partial<typeof prefs>) =>
    setPrefs({ payload: { patch }, reactivityKeys: [Keys.prefs] });
  return (
    <section className="space-y-3">
      <h3 className={settingsHeading}>{t`Default compose font`}</h3>
      <div className="flex gap-2">
        <Select
          aria-label={t`Font family`}
          value={prefs.composeFont.family}
          options={COMPOSE_FONT_FAMILIES.map((value) => ({ value, label: value }))}
          onValueChange={(family) => save({ composeFont: { ...prefs.composeFont, family } })}
        />
        <Select
          aria-label={t`Font size`}
          value={String(prefs.composeFont.size)}
          options={COMPOSE_FONT_SIZES.map((value) => ({
            value: String(value),
            label: `${value} px`,
          }))}
          onValueChange={(value) => {
            const size = COMPOSE_FONT_SIZES.find((candidate) => String(candidate) === value);
            if (size) save({ composeFont: { ...prefs.composeFont, size } });
          }}
        />
      </div>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={prefs.emojiReplacement}
          onCheckedChange={(emojiReplacement) => save({ emojiReplacement })}
        />
        <span>{t`Replace emoji text as you type`}</span>
      </label>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={prefs.contactPhotos}
          onCheckedChange={(contactPhotos) => save({ contactPhotos })}
        />
        <span>{t`Show Google contact photos`}</span>
      </label>
    </section>
  );
}

function ReplyFrom() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <section>
      <h3 className={settingsHeading}>{t`Reply From`}</h3>
      <Select
        aria-label={t`Reply From`}
        value={prefs.replyFrom}
        options={[
          { value: "received", label: t`Use the address the message was sent to` },
          { value: "default", label: t`Use the account default address` },
        ]}
        onValueChange={(replyFrom) =>
          setPrefs({ payload: { patch: { replyFrom } }, reactivityKeys: [Keys.prefs] })
        }
      />
    </section>
  );
}
