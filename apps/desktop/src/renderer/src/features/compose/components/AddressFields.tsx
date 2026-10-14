import { Trans, useLingui } from "@lingui/react/macro";
import type { RefObject } from "react";
import type { Prefs } from "../../../../../shared/api";
import { touchTarget } from "../../../ui/styles";
import { Select } from "../../../ui/Select";
import { ServiceHint } from "../../accounts/OptionalServices";
import type { Draft } from "../draft";
import type { useComposeRecipients } from "../hooks/use-compose-recipients";
import { label, row } from "./composer-styles";
import { RecipientField } from "./RecipientField";

/** The From, To, Cc and Bcc rows of the composer. */
export function AddressFields({
  draft,
  prefs,
  recipients,
  describedBy,
  toRef,
  ccRef,
}: {
  draft: Draft;
  prefs: Prefs;
  recipients: ReturnType<typeof useComposeRecipients>;
  /** The error under the form, while there is one. */
  describedBy: string | undefined;
  toRef: RefObject<HTMLInputElement | null>;
  ccRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useLingui();
  const {
    account,
    availableSenders,
    showBcc,
    setShowBcc,
    moveChip,
    dropChip,
    selectSender,
    revertSender,
    senderUndo,
    changeRecipients,
  } = recipients;
  return (
    <>
      <div className={`${row} items-center`}>
        <span className={label}>
          <Trans>From</Trans>
        </span>
        <Select
          aria-label={t`From`}
          value={`${draft.accountId}/${draft.from?.address ?? account?.email ?? ""}`}
          onValueChange={selectSender}
          options={availableSenders.map((sender) => ({
            value: `${sender.accountId}/${sender.address}`,
            label: sender.name ? `${sender.name} (${sender.address})` : sender.address,
          }))}
          className="max-w-full"
        />
        {senderUndo && (
          <output className="flex items-center gap-2 text-footnote text-a11y-muted">
            {t`From updated`}
            <button
              type="button"
              className="text-a11y-accent"
              onClick={revertSender}
            >{t`Revert`}</button>
          </output>
        )}
      </div>
      <ServiceHint accountId={draft.accountId} service="contacts" />
      <div className={row}>
        <span className={label}>
          <Trans>To</Trans>
        </span>
        <RecipientField
          onDragChip={() => setShowBcc(true)}
          aria-describedby={describedBy}
          fieldName="to"
          onMove={(index, target) => moveChip("to", target, index)}
          onDropRecipient={(chip) => dropChip("to", chip)}
          label={t`To`}
          inputRef={toRef}
          value={draft.to}
          onChange={(to) => changeRecipients("to", to)}
          showFullAddresses={prefs.showFullRecipientAddresses}
          from={draft.from?.address ?? account?.email}
        />
        {!showBcc && (
          <button
            type="button"
            onClick={() => setShowBcc(true)}
            className={`h-9 shrink-0 text-a11y-muted hover:text-neutral-800 coarse:h-11 dark:hover:text-neutral-200 ${touchTarget}`}
          >
            <Trans>Cc/Bcc</Trans>
          </button>
        )}
      </div>
      {showBcc && (
        <>
          <div className={row}>
            <span className={label}>
              <Trans>Cc</Trans>
            </span>
            <RecipientField
              aria-describedby={describedBy}
              fieldName="cc"
              onMove={(index, target) => moveChip("cc", target, index)}
              onDropRecipient={(chip) => dropChip("cc", chip)}
              label={t`Cc`}
              inputRef={ccRef}
              value={draft.cc}
              onChange={(cc) => changeRecipients("cc", cc)}
              showFullAddresses={prefs.showFullRecipientAddresses}
              from={draft.from?.address ?? account?.email}
            />
          </div>
          <div className={row}>
            <span className={label}>
              <Trans>Bcc</Trans>
            </span>
            <RecipientField
              aria-describedby={describedBy}
              fieldName="bcc"
              onMove={(index, target) => moveChip("bcc", target, index)}
              onDropRecipient={(chip) => dropChip("bcc", chip)}
              label={t`Bcc`}
              value={draft.bcc}
              onChange={(bcc) => changeRecipients("bcc", bcc)}
              showFullAddresses={prefs.showFullRecipientAddresses}
              from={draft.from?.address ?? account?.email}
            />
          </div>
        </>
      )}
    </>
  );
}
