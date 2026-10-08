import { useAtomValue } from "@effect/atom-react";
import {
  applyComposeSignature,
  orderedSignatures,
  reconcileMentionRecipients,
  type Address,
  type Prefs,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult } from "effect/reactivity";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Account } from "../../../shared/api";
import { defaultSignature, formatAddress, parseAddresses, type Draft } from "../draft";
import {
  moveRecipient,
  recipientTokens,
  type RecipientDrag,
  type RecipientFieldName,
} from "../recipient-actions";
import { useRunMail, withMail } from "../state/mail";
import { namedSignaturesAtom, sendAsAtom, signaturesAtom } from "../state/queries";

export function useComposeRecipients({
  initial,
  accounts,
  draft,
  prefs,
  setDraft,
  set,
  run,
}: {
  initial: Draft;
  accounts: readonly Account[];
  draft: Draft;
  prefs: Prefs;
  setDraft: Dispatch<SetStateAction<Draft>>;
  set: (patch: Partial<Draft>) => void;
  run: ReturnType<typeof useRunMail>;
}) {
  const freshMentions = useRef(new Map<string, Address>());
  const activeMentions = useRef(new Set<string>());
  const manualSender = useRef(false);
  const [senderUndo, setSenderUndo] = useState<{ accountId: string; address: string } | null>(null);

  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc || initial.cc));

  const account = accounts.find((a) => a.id === draft.accountId);
  const library = AsyncResult.getOrElse(useAtomValue(namedSignaturesAtom), () => []);
  const defaultSignatures = AsyncResult.getOrElse(useAtomValue(signaturesAtom), () => []);
  const signatureAt = (accountId: string, from: string | undefined) =>
    defaultSignature(defaultSignatures, accounts, accountId, draft.mode, from);
  const currentSignature =
    draft.signatureId === undefined
      ? signatureAt(draft.accountId, draft.from?.address)
      : library.find((s) => s.id === draft.signatureId);
  const currentAddress = (draft.from?.address ?? account?.email ?? "").toLowerCase();
  const localSignatures = orderedSignatures(library, prefs.signatureOrder).filter(
    (s) => s.address === currentAddress,
  );

  const moveChip = (source: RecipientFieldName, target: RecipientFieldName, index: number) => {
    setDraft((current) => ({ ...current, ...moveRecipient(current, source, target, index) }));
    if (target !== "to") setShowBcc(true);
  };
  const dropChip = (target: RecipientFieldName, chip: RecipientDrag) => {
    const tokens = recipientTokens(draft[chip.source]);
    if (tokens[chip.index] === chip.text) moveChip(chip.source, target, chip.index);
  };
  const aliases = AsyncResult.getOrElse(useAtomValue(sendAsAtom), () => []);
  const senders = accounts
    .filter((a) => a.enabled !== false)
    .flatMap((a) => [
      { accountId: a.id, address: a.email, name: a.description?.trim() || "" },
      ...aliases
        .filter(
          (alias) =>
            alias.accountId === a.id && alias.address.toLowerCase() !== a.email.toLowerCase(),
        )
        .map((alias) => ({ accountId: a.id, address: alias.address, name: alias.name })),
    ]);
  const availableSenders =
    draft.mode === "new" ? senders : senders.filter((s) => s.accountId === draft.accountId);

  const changeSender = (key: string) => {
    const sender = senders.find((s) => `${s.accountId}/${s.address}` === key);
    if (!sender) return;
    set({
      accountId: sender.accountId,
      organization: sender.accountId === draft.accountId ? draft.organization : undefined,
      from: { name: sender.name, address: sender.address },
      signatureId: undefined,
      body: applyComposeSignature(
        draft.body,
        currentSignature,
        signatureAt(sender.accountId, sender.address),
        prefs,
      ),
    });
  };
  const chooseSignature = (id: string) => {
    const signature =
      id === "default"
        ? signatureAt(draft.accountId, draft.from?.address)
        : localSignatures.find((s) => s.id === id);
    set({
      signatureId: id === "default" ? undefined : id === "none" ? null : id,
      body: applyComposeSignature(draft.body, currentSignature, signature, prefs),
    });
  };

  const applyAutomaticSender = useEffectEvent((sender: { accountId: string; address: string }) => {
    if (
      initial.synced !== undefined ||
      manualSender.current ||
      prefs.defaultFrom ||
      draft.mode !== "new"
    )
      return;
    setSenderUndo({
      accountId: draft.accountId,
      address: draft.from?.address ?? account?.email ?? "",
    });
    changeSender(`${sender.accountId}/${sender.address}`);
  });
  const currentFrom = draft.from?.address ?? account?.email ?? "";
  useEffect(() => {
    if (
      initial.synced !== undefined ||
      draft.mode !== "new" ||
      prefs.defaultFrom ||
      manualSender.current ||
      !currentFrom
    )
      return constVoid;
    let active = true;
    const timer = setTimeout(
      () =>
        run(
          withMail((call) =>
            call("SuggestSender", {
              current: { accountId: draft.accountId, address: currentFrom },
              recipients: parseAddresses([draft.to, draft.cc, draft.bcc].join(", ")).addresses.map(
                (a) => a.address,
              ),
              accountIds: accounts.filter((a) => a.enabled !== false).map((a) => a.id),
            }),
          ).pipe(
            Effect.matchCause({
              onSuccess: (sender) => {
                if (active && sender) applyAutomaticSender(sender);
              },
              onFailure: constVoid,
            }),
          ),
        ),
      300,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    initial.synced,
    currentFrom,
    draft.mode,
    draft.accountId,
    draft.to,
    draft.cc,
    draft.bcc,
    prefs.defaultFrom,
    accounts,
    run,
  ]);

  const addMention = (person: Address) => {
    setDraft((current) => {
      const result = reconcileMentionRecipients(
        parseAddresses(current.to).addresses,
        [...parseAddresses(current.cc).addresses, ...parseAddresses(current.bcc).addresses],
        [...freshMentions.current.values()]
          .filter((a) => activeMentions.current.has(a.address.toLowerCase()))
          .concat(person),
        new Set(freshMentions.current.keys()),
      );
      for (const recipient of result.to)
        if (result.fresh.has(recipient.address.toLowerCase()))
          freshMentions.current.set(recipient.address.toLowerCase(), recipient);
      return {
        ...current,
        to: [...result.to.map(formatAddress), ...parseAddresses(current.to).invalid].join(", "),
      };
    });
  };
  const removeMentions = (active: readonly string[]) => {
    const have = new Set(active.map((address) => address.toLowerCase()));
    activeMentions.current = have;
    if (!freshMentions.current.size) return;
    setDraft((current) => {
      const result = reconcileMentionRecipients(
        parseAddresses(current.to).addresses,
        [...parseAddresses(current.cc).addresses, ...parseAddresses(current.bcc).addresses],
        [...freshMentions.current.values()].filter((person) =>
          have.has(person.address.toLowerCase()),
        ),
        new Set(freshMentions.current.keys()),
      );
      const to = [...result.to.map(formatAddress), ...parseAddresses(current.to).invalid].join(
        ", ",
      );
      return to === current.to ? current : { ...current, to };
    });
  };

  const changeRecipients = (field: RecipientFieldName, value: string) => {
    if (field === "to") freshMentions.current.clear();
    else
      for (const person of parseAddresses(value).addresses)
        freshMentions.current.delete(person.address.toLowerCase());
    set({ [field]: value });
  };
  const selectSender = (key: string) => {
    manualSender.current = true;
    setSenderUndo(null);
    changeSender(key);
  };
  const revertSender = () => {
    if (!senderUndo) return;
    manualSender.current = true;
    changeSender(`${senderUndo.accountId}/${senderUndo.address}`);
    setSenderUndo(null);
  };

  return {
    account,
    aliases,
    currentSignature,
    currentAddress,
    localSignatures,
    availableSenders,
    showBcc,
    setShowBcc,
    moveChip,
    dropChip,
    selectSender,
    revertSender,
    chooseSignature,
    senderUndo,
    changeRecipients,
    currentFrom,
    addMention,
    removeMentions,
  };
}
