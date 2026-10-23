import { constVoid } from "effect/Function";
import { Exit } from "effect";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import {
  DEFAULT_PREFS,
  signatureDefault,
  orderedSignatures,
  richComposeBody,
  textComposeHtml,
  type ComposeBody,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { Account, NamedSignature } from "../../../../../shared/api";
import type { ComposeElement } from "../../compose/compose-editor-dom";
import { causeText } from "../../../lib/errors";
import { scrollBehavior } from "../../../lib/scroll-motion";
import { Keys } from "../../../state/keys";
import {
  deleteNamedSignatureAtom,
  saveNamedSignatureAtom,
  setSignatureDefaultAtom,
  setPrefsAtom,
} from "../../../state/mutations";
import {
  namedSignaturesAtom,
  signatureDefaultsAtom,
  sendAsAtom,
  prefsAtom,
} from "../../../state/queries";
import { ComposeEditor } from "../../compose/components/ComposeEditor";
import { Select } from "../../../ui/Select";
import { SettingsGroup, SettingsRow, SettingsSwitchRow } from "../../../ui/SettingsRows";
import {
  buttonLink,
  buttonPrimary,
  buttonSecondary,
  formInput,
  iconButton,
  settingsHint,
} from "../../../ui/styles";

/** A text action in a signature row. Callers add the color. */
const rowAction =
  "shrink-0 rounded-item font-medium outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2";
/** A small icon button that reorders a signature. */
const moveButton = `flex size-6 shrink-0 items-center justify-center text-a11y-muted outline-offset-1 outline-a11y-focus focus-visible:outline-2 disabled:opacity-30 disabled:hover:bg-transparent ${iconButton}`;
/** The box an inline editor sits in, below the settings groups. */
const editorCard = "rounded-card bg-raised px-4 pt-3 pb-4 ring-1 ring-edge dark:bg-white/[0.03]";
/** The editor's title: a legend floated into the box so the padding stays even. */
const editorLegend = "float-left mb-3 w-full p-0 text-callout font-semibold";
/** A field's label, above the field. */
const fieldLabel = "mb-1 block text-footnote font-medium text-a11y-muted";

type SignatureForm = { id?: string; address: string; name: string; body: ComposeBody };
export function SignatureSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const aliases = AsyncResult.getOrElse(useAtomValue(sendAsAtom), () => []);
  const library = AsyncResult.getOrElse(useAtomValue(namedSignaturesAtom), () => []);
  const defaults = AsyncResult.getOrElse(useAtomValue(signatureDefaultsAtom), () => []);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  const drag = useRef<string | null>(null);
  const order = (ids: string[]) =>
    setPrefs({ payload: { patch: { signatureOrder: ids } }, reactivityKeys: [Keys.prefs] });
  const reorder = (from: string, to: string) => {
    const ids = orderedSignatures(library, prefs.signatureOrder).map((signature) => signature.id);
    const source = library.find((s) => s.id === from);
    if (
      source?.source !== "local" ||
      !library.some((s) => s.id === to && s.address === source.address)
    )
      return;
    const target = ids.indexOf(to);
    order(ids.filter((id) => id !== from).toSpliced(target, 0, from));
  };
  const remove = useAtomSet(deleteNamedSignatureAtom);
  const setDefault = useAtomSet(setSignatureDefaultAtom);
  const [form, setForm] = useState<SignatureForm | null>(null);
  const positionId = useId();
  const addresses = [
    ...new Set(
      accounts.flatMap((a) => [
        a.email.toLowerCase(),
        ...aliases.filter((s) => s.accountId === a.id).map((s) => s.address.toLowerCase()),
      ]),
    ),
  ];
  const open = (signature: NamedSignature) =>
    setForm({
      ...(signature.source === "local" ? { id: signature.id } : {}),
      address: signature.address,
      name: signature.source === "gmail" ? t`Gmail copy` : signature.name,
      body: richComposeBody(signature.html ?? textComposeHtml(signature.text)),
    });
  return (
    <section className="space-y-6">
      {addresses.map((address) => {
        const signatures = orderedSignatures(library, prefs.signatureOrder).filter(
          (signature) => signature.address === address,
        );
        return (
          <SettingsGroup key={address} title={address}>
            {(["new", "reply"] as const).map((kind) => (
              <SettingsRow
                key={kind}
                label={kind === "new" ? t`New messages` : t`Replies and forwards`}
              >
                <Select
                  variant="field"
                  className="min-w-40"
                  aria-label={
                    kind === "new"
                      ? t`New message signature for ${address}`
                      : t`Reply signature for ${address}`
                  }
                  value={signatureDefault(library, defaults, address, kind)?.id ?? "none"}
                  options={[
                    { value: "none", label: t`None` },
                    ...signatures.map((s) => ({
                      value: s.id,
                      label: s.source === "gmail" ? t`Gmail default` : s.name,
                    })),
                  ]}
                  onValueChange={(id) =>
                    setDefault({
                      payload: {
                        setting: { address, kind, signatureId: id === "none" ? null : id },
                      },
                      reactivityKeys: [Keys.signatures],
                    })
                  }
                />
              </SettingsRow>
            ))}
            {signatures.map((signature, index) => (
              <div
                key={signature.id}
                className="flex min-h-10 items-center gap-1 px-3 py-1.5"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (drag.current) reorder(drag.current, signature.id);
                  drag.current = null;
                }}
              >
                {signature.source === "local" && (
                  <>
                    <button
                      type="button"
                      draggable
                      onDragStart={() => {
                        drag.current = signature.id;
                      }}
                      onDragEnd={() => {
                        drag.current = null;
                      }}
                      aria-label={t`Drag ${signature.name} to reorder`}
                      className={`${moveButton} cursor-grab`}
                    >
                      <GripVertical aria-hidden className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={index === 0}
                      aria-label={t`Move ${signature.name} up`}
                      className={moveButton}
                      onClick={() => {
                        const target = signatures[index - 1];
                        if (target) reorder(signature.id, target.id);
                      }}
                    >
                      <ChevronUp aria-hidden className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={index === signatures.length - 1}
                      aria-label={t`Move ${signature.name} down`}
                      className={moveButton}
                      onClick={() => {
                        const target = signatures[index + 1];
                        if (target) reorder(signature.id, target.id);
                      }}
                    >
                      <ChevronDown aria-hidden className="size-3.5" />
                    </button>
                  </>
                )}
                <span className="ml-1 min-w-0 flex-1 truncate">
                  {signature.source === "gmail" ? t`Gmail default` : signature.name}
                </span>
                <button
                  type="button"
                  className={`ml-2 ${buttonLink}`}
                  onClick={() => open(signature)}
                >
                  {signature.source === "gmail" ? t`Copy to local signature` : t`Edit`}
                </button>
                {signature.source === "local" && (
                  <button
                    type="button"
                    className={`ml-2 ${rowAction} text-a11y-danger`}
                    aria-label={t`Delete ${signature.name}`}
                    onClick={() =>
                      remove({ payload: { id: signature.id }, reactivityKeys: [Keys.signatures] })
                    }
                  >{t`Delete`}</button>
                )}
              </div>
            ))}
            <div className="flex justify-end px-3 py-2">
              <button
                type="button"
                className={buttonSecondary}
                onClick={() => setForm({ address, name: "", body: richComposeBody("") })}
              >{t`New signature`}</button>
            </div>
          </SettingsGroup>
        );
      })}
      <SettingsGroup
        footer={t`Local signatures stay on this Mac. Gmail default signatures are read from Gmail.`}
      >
        <SettingsRow label={t`Signature position in replies`} htmlFor={positionId}>
          <Select
            id={positionId}
            variant="field"
            className="min-w-40"
            value={prefs.signaturePosition}
            aria-label={t`Signature position in replies`}
            options={[
              { value: "above", label: t`Above quoted text` },
              { value: "below", label: t`Below quoted text` },
            ]}
            onValueChange={(value) => {
              setPrefs({
                payload: { patch: { signaturePosition: value } },
                reactivityKeys: [Keys.prefs],
              });
            }}
          />
        </SettingsRow>
        <SettingsSwitchRow
          label={t`Include signature separator`}
          checked={prefs.signatureSeparator}
          onCheckedChange={(signatureSeparator) =>
            setPrefs({
              payload: { patch: { signatureSeparator } },
              reactivityKeys: [Keys.prefs],
            })
          }
        />
      </SettingsGroup>
      {form && (
        <SignatureEditor
          key={`${form.address}/${form.id ?? "new"}`}
          initial={form}
          onClose={() => setForm(null)}
        />
      )}
    </section>
  );
}
function SignatureEditor({ initial, onClose }: { initial: SignatureForm; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const [form, setForm] = useState(initial);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const [state, save] = useAtom(saveNamedSignatureAtom, { mode: "promiseExit" });

  const [error, setError] = useState("");
  const bodyRef = useRef<ComposeElement>(null);
  const selectionRef = useRef<Range>(null);
  const card = useRef<HTMLFieldSetElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  // The editor opens below every account's list, often off-screen: bring it up, ready for a name.
  useEffect(() => {
    card.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    nameField.current?.focus({ preventScroll: true });
  }, []);
  return (
    <fieldset ref={card} className={editorCard}>
      <legend className={editorLegend}>{t`Edit signature`}</legend>
      <div className="clear-both space-y-4">
        <label className="block">
          <span className={fieldLabel}>{t`Signature name`}</span>
          <input
            ref={nameField}
            className={formInput}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <div className="flex h-56 flex-col overflow-hidden rounded-control border border-control bg-white dark:bg-white/[0.05]">
          <ComposeEditor
            shortcutSet={prefs.shortcutSet}
            prefs={{ ...prefs, composeFormatBar: true }}
            from={form.address}
            onImageSize={constVoid}
            onMention={constVoid}
            onMentionsChange={constVoid}
            body={form.body}
            attachments={[]}
            bodyRef={bodyRef}
            selectionRef={selectionRef}
            onChange={(body) => setForm((previous) => ({ ...previous, body }))}
          />
        </div>
        {error && (
          <p role="alert" className="text-a11y-danger">
            {error}
          </p>
        )}
        {state._tag === "Failure" && (
          <p role="alert" className="text-a11y-danger">
            {causeText(i18n, state.cause)}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {state._tag === "Success" && !state.waiting && (
            <output className={`mr-auto ${settingsHint}`}>{t`Saved`}</output>
          )}
          <button type="button" className={buttonSecondary} onClick={onClose}>{t`Close`}</button>
          <button
            type="button"
            disabled={state.waiting}
            className={buttonPrimary}
            onClick={() => {
              if (!form.name.trim()) {
                setError(t`Enter a signature name.`);
                return;
              }
              setError("");
              void save({
                payload: {
                  ...(form.id ? { id: form.id } : {}),
                  input: {
                    address: form.address,
                    name: form.name,
                    text: form.body.text,
                    ...(form.body.kind === "rich" ? { html: form.body.html } : {}),
                  },
                },
                reactivityKeys: [Keys.signatures],
              }).then((exit) => {
                if (Exit.isSuccess(exit))
                  setForm((previous) => ({ ...previous, id: exit.value.id }));
                return exit;
              });
            }}
          >{t`Save`}</button>
        </div>
      </div>
    </fieldset>
  );
}
