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
import { useState } from "react";

import type { Account, SignatureKind } from "../../../shared/api";
import { Keys } from "../state/keys";
import {
  deleteTemplateAtom,
  setContactHiddenAtom,
  setPrefsAtom,
  setSignatureAtom,
} from "../state/mutations";
import {
  accountsAtom,
  sendAsAtom,
  hiddenContactsAtom,
  prefsAtom,
  signaturesAtom,
  templatesAtom,
} from "../state/queries";
import { Select } from "./ui/Select";
import { Checkbox } from "./ui/Checkbox";
import { SegmentedControl } from "./ui/SegmentedControl";

const heading = "mb-2 text-[12px] font-semibold text-neutral-500 dark:text-neutral-400";
const box = "rounded-lg border border-black/10 dark:border-white/10";

/** Settings > Compose: undo send, signatures, templates, hidden recipients. */
export function ComposeSettings() {
  return (
    <div className="space-y-6">
      <DefaultFrom />
      <ComposeAppearance />
      <RecipientAddresses />
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
      <h3 className={heading}>
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
      <p className="mt-2 text-neutral-500 dark:text-neutral-400">
        <Trans>
          After you click Send, the message waits this long. You can undo it until then.
        </Trans>
      </p>
    </section>
  );
}

export function Signatures({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  return (
    <section>
      <h3 className={heading}>
        <Trans>Signatures</Trans>
      </h3>
      <div className="space-y-4">
        {accounts.map((a) => (
          <div key={a.id}>
            <p className="mb-1.5 font-medium">{a.email}</p>
            <div className="grid grid-cols-2 gap-2">
              <SignatureField address={a.email} kind="new" label={t`New messages`} />
              <SignatureField address={a.email} kind="reply" label={t`Replies and forwards`} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-neutral-500 dark:text-neutral-400">
        <Trans>
          Added as you write, and switched when you change the From account. Signatures stay on this
          Mac.
        </Trans>
      </p>
    </section>
  );
}

function SignatureField({
  address,
  kind,
  label,
}: {
  address: string;
  kind: SignatureKind;
  label: string;
}) {
  const signatures = AsyncResult.getOrElse(useAtomValue(signaturesAtom), () => []);
  const stored =
    signatures.find((s) => s.address === address.toLowerCase() && s.kind === kind)?.text ?? "";
  const [text, setText] = useState<string | null>(null);
  const setSignature = useAtomSet(setSignatureAtom);
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-neutral-500">{label}</span>
      <textarea
        value={text ?? stored}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text === null || text === stored) return;
          setSignature({
            payload: { signature: { address, kind, text } },
            reactivityKeys: [Keys.signatures],
          });
          setText(null);
        }}
        className={`${box} w-full resize-none bg-transparent px-2.5 py-1.5 outline-none focus:border-blue-500`}
      />
    </label>
  );
}

function Templates() {
  const templates = AsyncResult.getOrElse(useAtomValue(templatesAtom), () => []);
  const remove = useAtomSet(deleteTemplateAtom);
  return (
    <section>
      <h3 className={heading}>
        <Trans>Templates</Trans>
      </h3>
      {templates.length === 0 ? (
        <p className="text-neutral-500 dark:text-neutral-400">
          <Trans>
            No templates yet. While writing, press ⌘/ and choose “Save this message as a template”.
          </Trans>
        </p>
      ) : (
        <ul className={`${box} divide-y divide-black/[0.07] dark:divide-white/[0.08]`}>
          {templates.map((template) => (
            <li key={template.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{template.name}</span>
                <span className="block truncate text-[12px] text-neutral-500">
                  {template.subject || template.body.replace(/\s+/g, " ").slice(0, 80)}
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  remove({ payload: { id: template.id }, reactivityKeys: [Keys.templates] })
                }
                className="h-7 shrink-0 rounded-md px-2.5 text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                <Trans>Delete</Trans>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HiddenContacts() {
  const hidden = AsyncResult.getOrElse(useAtomValue(hiddenContactsAtom), () => []);
  const setHidden = useAtomSet(setContactHiddenAtom);
  if (hidden.length === 0) return null;
  return (
    <section>
      <h3 className={heading}>
        <Trans>Addresses no longer suggested</Trans>
      </h3>
      <ul className={`${box} divide-y divide-black/[0.07] dark:divide-white/[0.08]`}>
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
              className="h-7 shrink-0 rounded-md px-2.5 text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
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
      <h3 className={heading}>{t`Default From address`}</h3>
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
      <h3 className={heading}>{t`Quote selected text`}</h3>
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
      <h3 className={heading}>{t`Default compose font`}</h3>
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
