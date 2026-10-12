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
import { SettingsCheckRow, SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import { buttonLink, settingsHint } from "../../../ui/styles";
import { SegmentedControl } from "../../../ui/SegmentedControl";

/** Settings > Compose: undo send, signatures, templates, hidden recipients. */
export function ComposeSettings() {
  return (
    <>
      <SettingsGroup>
        <DefaultFrom />
        <ReplyFrom />
      </SettingsGroup>
      <SettingsGroup>
        <ComposeAppearance />
      </SettingsGroup>
      <SettingsGroup>
        <RecipientAddresses />
        <AppleContactsSettings />
      </SettingsGroup>
      <SettingsGroup>
        <QuoteSelection />
        <UndoSend />
      </SettingsGroup>
      <Templates />
      <HiddenContacts />
    </>
  );
}

function RecipientAddresses() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <SettingsCheckRow>
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
    </SettingsCheckRow>
  );
}

function UndoSend() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <div className="space-y-2 px-3 py-2">
      <span className="block">
        <Trans>Undo Send</Trans>
      </span>
      <SegmentedControl
        aria-label={t`Undo send delay`}
        className="w-full"
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
      <p className={settingsHint}>
        <Trans>
          After you click Send, the message waits this long. You can undo it until then.
        </Trans>
      </p>
    </div>
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
    <SettingsGroup title={<Trans>Addresses no longer suggested</Trans>}>
      <ul className="divide-y divide-separator">
        {hidden.map((address) => (
          <li key={address} className="flex min-h-10 items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate">{address}</span>
            <button
              type="button"
              onClick={() =>
                setHidden({
                  payload: { address, hidden: false },
                  reactivityKeys: [Keys.contacts],
                })
              }
              className={`shrink-0 ${buttonLink}`}
            >
              <Trans>Restore</Trans>
            </button>
          </li>
        ))}
      </ul>
    </SettingsGroup>
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
    <SettingsRow label={t`Default From address`}>
      <Select
        aria-label={t`Default From address`}
        variant="field"
        className="max-w-64 min-w-40"
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
    </SettingsRow>
  );
}

function QuoteSelection() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <SettingsRow label={t`Quote selected text`}>
      <Select
        aria-label={t`Quote selected text`}
        variant="field"
        className="max-w-64 min-w-40"
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
    </SettingsRow>
  );
}

function ComposeAppearance() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  const save = (patch: Partial<typeof prefs>) =>
    setPrefs({ payload: { patch }, reactivityKeys: [Keys.prefs] });
  return (
    <>
      <SettingsRow label={t`Default compose font`}>
        <Select
          aria-label={t`Font family`}
          variant="field"
          className="min-w-32"
          value={prefs.composeFont.family}
          options={COMPOSE_FONT_FAMILIES.map((value) => ({ value, label: value }))}
          onValueChange={(family) => save({ composeFont: { ...prefs.composeFont, family } })}
        />
        <Select
          aria-label={t`Font size`}
          variant="field"
          className="min-w-20"
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
      </SettingsRow>
      <SettingsCheckRow>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={prefs.emojiReplacement}
            onCheckedChange={(emojiReplacement) => save({ emojiReplacement })}
          />
          <span>{t`Replace emoji text as you type`}</span>
        </label>
      </SettingsCheckRow>
      <SettingsCheckRow>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={prefs.contactPhotos}
            onCheckedChange={(contactPhotos) => save({ contactPhotos })}
          />
          <span>{t`Show Google contact photos`}</span>
        </label>
      </SettingsCheckRow>
    </>
  );
}

function ReplyFrom() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <SettingsRow label={t`Reply From`}>
      <Select
        aria-label={t`Reply From`}
        variant="field"
        className="max-w-64 min-w-40"
        value={prefs.replyFrom}
        options={[
          { value: "received", label: t`Use the address the message was sent to` },
          { value: "default", label: t`Use the account default address` },
        ]}
        onValueChange={(replyFrom) =>
          setPrefs({ payload: { patch: { replyFrom } }, reactivityKeys: [Keys.prefs] })
        }
      />
    </SettingsRow>
  );
}
