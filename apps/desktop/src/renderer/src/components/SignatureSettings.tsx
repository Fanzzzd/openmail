import { constVoid } from "effect/Function";
import { Exit } from "effect";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_PREFS,
  signatureDefault,
  orderedSignatures,
  richComposeBody,
  textComposeHtml,
  type ComposeBody,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import type { Account, NamedSignature } from "../../../shared/api";
import type { ComposeElement } from "../compose-editor-dom";
import { causeText } from "../errors";
import { Keys } from "../state/keys";
import {
  deleteNamedSignatureAtom,
  saveNamedSignatureAtom,
  setSignatureDefaultAtom,
  setPrefsAtom,
} from "../state/mutations";
import {
  namedSignaturesAtom,
  signatureDefaultsAtom,
  sendAsAtom,
  prefsAtom,
} from "../state/queries";
import { ComposeEditor } from "./ComposeEditor";
import { Checkbox } from "./ui/Checkbox";
import { Select } from "./ui/Select";

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
    <section className="space-y-4">
      <h3 className="text-[12px] font-semibold text-neutral-500">
        <Trans>Signatures</Trans>
      </h3>
      {addresses.map((address) => {
        const signatures = orderedSignatures(library, prefs.signatureOrder).filter(
          (signature) => signature.address === address,
        );
        return (
          <div
            key={address}
            className="space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/10"
          >
            <p className="font-medium">{address}</p>
            {(["new", "reply"] as const).map((kind) => (
              <div key={kind} className="flex items-center justify-between gap-3">
                <span>{kind === "new" ? t`New messages` : t`Replies and forwards`}</span>
                <Select
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
              </div>
            ))}
            {signatures.map((signature, index) => (
              <div
                key={signature.id}
                className="flex items-center gap-3"
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
                    >
                      ↕
                    </button>
                    <button
                      type="button"
                      disabled={index === 0}
                      aria-label={t`Move ${signature.name} up`}
                      onClick={() => {
                        const target = signatures[index - 1];
                        if (target) reorder(signature.id, target.id);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === signatures.length - 1}
                      aria-label={t`Move ${signature.name} down`}
                      onClick={() => {
                        const target = signatures[index + 1];
                        if (target) reorder(signature.id, target.id);
                      }}
                    >
                      ↓
                    </button>
                  </>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {signature.source === "gmail" ? t`Gmail default` : signature.name}
                </span>
                <button type="button" onClick={() => open(signature)}>
                  {signature.source === "gmail" ? t`Copy to local signature` : t`Edit`}
                </button>
                {signature.source === "local" && (
                  <button
                    type="button"
                    className="text-red-600"
                    aria-label={t`Delete ${signature.name}`}
                    onClick={() =>
                      remove({ payload: { id: signature.id }, reactivityKeys: [Keys.signatures] })
                    }
                  >{t`Delete`}</button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="text-blue-600"
              onClick={() => setForm({ address, name: "", body: richComposeBody("") })}
            >{t`New signature`}</button>
          </div>
        );
      })}
      <label className="flex items-center justify-between gap-3">
        {t`Signature position in replies`}
        <Select
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
      </label>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={prefs.signatureSeparator}
          onCheckedChange={(signatureSeparator) =>
            setPrefs({ payload: { patch: { signatureSeparator } }, reactivityKeys: [Keys.prefs] })
          }
        />
        {t`Include signature separator`}
      </label>
      <p className="text-neutral-500">{t`Local signatures stay on this Mac. Gmail default signatures are read from Gmail.`}</p>
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
  return (
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend>{t`Edit signature`}</legend>
      <label className="block">
        {t`Signature name`}
        <input
          className="mt-1 w-full rounded border bg-transparent px-2 py-1"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <div className="flex h-56 flex-col overflow-hidden rounded border">
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
      {error && <p className="text-red-600">{error}</p>}
      {state._tag === "Failure" && <p className="text-red-600">{causeText(i18n, state.cause)}</p>}
      {state._tag === "Success" && !state.waiting && <output>{t`Saved`}</output>}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={state.waiting}
          className="rounded bg-blue-600 px-3 py-1 text-white"
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
              if (Exit.isSuccess(exit)) setForm((previous) => ({ ...previous, id: exit.value.id }));
              return exit;
            });
          }}
        >{t`Save`}</button>
        <button type="button" onClick={onClose}>{t`Close`}</button>
      </div>
    </fieldset>
  );
}
