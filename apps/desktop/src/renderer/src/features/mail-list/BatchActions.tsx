import { MultiOrganizationItem } from "../organize";
import { moveSourceLabel, providerCapabilities } from "@openmail/core/schema";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Archive, Mail, MailOpen, Star, Tag, Trash2 } from "lucide-react";
import type { Account, Label, MailOp, Mailbox, ThreadSummary } from "../../../../shared/api";
import {
  ContextSubmenu,
  DropdownMenu,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
} from "../../ui/Menu";
import { Tip } from "../../ui/Tip";

interface Props {
  rows: readonly ThreadSummary[];
  accounts: readonly Account[];
  labels: readonly Label[];
  onPermanentDelete?: (() => void) | undefined;
  mailbox: Mailbox;
  currentLabel?: string | undefined;
  onCreate?: ((accountId: string, move: boolean) => void) | undefined;
  onOp: (op: MailOp, accountId?: string) => void;
}

/** Labels belong to an account; a folder choice never reaches another account. */
export function BatchMenuItems({
  rows,
  accounts,
  labels,
  onOp,
  onPermanentDelete,
  currentLabel,
  onCreate,
  mailbox,
}: Props) {
  const { t } = useLingui();
  return (
    <>
      <MenuItem icon={Archive} onClick={() => onOp({ kind: "archive" })}>{t`Archive`}</MenuItem>
      <MenuItem icon={Trash2} onClick={() => onOp({ kind: "trash" })}>{t`Delete`}</MenuItem>
      {onPermanentDelete && (
        <MenuItem icon={Trash2} onClick={onPermanentDelete}>{t`Permanently delete`}</MenuItem>
      )}
      <MenuItem
        icon={MailOpen}
        onClick={() => onOp({ kind: "read", value: true })}
      >{t`Mark as read`}</MenuItem>
      <MenuItem
        icon={Mail}
        onClick={() => onOp({ kind: "read", value: false })}
      >{t`Mark as unread`}</MenuItem>
      <MenuItem icon={Star} onClick={() => onOp({ kind: "star", value: true })}>{t`Star`}</MenuItem>
      <MenuItem
        icon={Star}
        onClick={() => onOp({ kind: "star", value: false })}
      >{t`Unstar`}</MenuItem>
      {accounts
        .filter((account) => rows.some((row) => row.accountId === account.id))
        .map((account) => {
          const selected = rows.filter((row) => row.accountId === account.id);
          const available = labels.filter((label) => label.accountId === account.id);
          const folders = providerCapabilities(account.provider).organization === "folders";

          return (
            <div key={account.id}>
              <MenuSeparator />
              <div className="px-2 py-1 text-footnote text-a11y-muted">
                {account.email} · {folders ? t`Move to folder` : t`Labels`}
              </div>
              <ContextSubmenu icon={Tag} label={t`Move to`}>
                {available
                  .filter((label) => !label.id.startsWith("category:"))
                  .map((label) => (
                    <MenuItem
                      key={`move:${label.id}`}
                      onClick={() =>
                        onOp(
                          {
                            kind: "move",
                            labelId: label.id,
                            removeLabelId: moveSourceLabel(mailbox, currentLabel),
                          },
                          account.id,
                        )
                      }
                    >
                      {label.name}
                    </MenuItem>
                  ))}
                {onCreate && (
                  <MenuItem
                    onClick={() => onCreate(account.id, true)}
                  >{t`New label or folder`}</MenuItem>
                )}
              </ContextSubmenu>
              {currentLabel && !folders && available.some((l) => l.id === currentLabel) && (
                <MenuItem
                  onClick={() =>
                    onOp({ kind: "label", labelId: currentLabel, value: false }, account.id)
                  }
                >{t`Remove current label`}</MenuItem>
              )}
              {folders && (
                <MultiOrganizationItem
                  provider={account.provider}
                  labels={available}
                  current={
                    selected[0]?.labels.filter((label) =>
                      selected.every((row) => row.labels.includes(label)),
                    ) ?? []
                  }
                  onOp={(op) => onOp(op, account.id)}
                />
              )}
              {available
                .filter(() => !folders)
                .map((label) => (
                  <MenuCheckboxItem
                    key={label.id}
                    checked={selected.every((row) => row.labels.includes(label.id))}
                    onCheckedChange={(value) =>
                      onOp(
                        {
                          kind: "label",
                          labelId: label.id,
                          value: folders ? true : value,
                        },
                        account.id,
                      )
                    }
                  >
                    {label.name}
                  </MenuCheckboxItem>
                ))}
              {onCreate && (
                <MenuItem
                  onClick={() => onCreate(account.id, folders)}
                >{t`New label or folder`}</MenuItem>
              )}
            </div>
          );
        })}
    </>
  );
}

export function BatchActions(
  props: Props & {
    labelPicker: boolean;
    onLabelPicker: (open: boolean) => void;
    canLoadMore: boolean;
    moreNotLoaded: number | null;
    /** Every loaded row is selected, as after Select all. */
    everyLoaded: boolean;
  },
) {
  const { t, i18n } = useLingui();
  const { rows, onOp } = props;
  const count = i18n.number(rows.length);
  const unread = rows.some((row) => row.isUnread);
  const starred = rows.every((row) => row.isStarred);
  const actions = [
    { icon: Archive, label: t`Archive`, op: { kind: "archive" } },
    { icon: Trash2, label: t`Delete`, op: { kind: "trash" } },
    {
      icon: unread ? MailOpen : Mail,
      label: unread ? t`Mark as read` : t`Mark as unread`,
      op: { kind: "read", value: unread },
    },
    { icon: Star, label: starred ? t`Unstar` : t`Star`, op: { kind: "star", value: !starred } },
  ] satisfies { icon: typeof Archive; label: string; op: MailOp }[];
  const button =
    "rounded-control p-1.5 text-a11y-muted hover:bg-fill-hover focus-visible:outline-a11y-focus";
  return (
    // Below 300 px the five buttons (150 px) leave the count text too little room, so the
    // count stands alone as a number and the actions keep their buttons.
    <div className="@container/batch flex min-w-0 flex-1 items-center gap-0.5">
      <span
        aria-hidden
        className="mr-1.5 hidden shrink-0 rounded-full bg-fill-pressed px-1.5 text-footnote leading-5 text-a11y-muted tabular-nums @max-[300px]/batch:inline"
      >
        {count}
      </span>
      <span className="mr-2 min-w-0 truncate text-callout text-a11y-muted @max-[300px]/batch:sr-only">
        <Plural
          value={rows.length}
          one="# selected (loaded)"
          other="# selected (loaded)"
          comment="Conversations selected in the list. Only loaded conversations can be selected."
        />
        {props.canLoadMore && props.everyLoaded && (
          <span className="ml-2">
            {/* No count, or 0 while the server still has older mail: the number is unknown. */}
            {!props.moreNotLoaded ? (
              <Trans>More messages not loaded</Trans>
            ) : (
              <Plural
                value={props.moreNotLoaded}
                one="# more not loaded"
                other="# more not loaded"
                comment="Messages on the server that are not in the list yet."
              />
            )}
          </span>
        )}
      </span>
      {actions.map(({ icon: Icon, label, op }) => (
        <Tip key={op.kind} label={label}>
          <button
            type="button"
            aria-label={label}
            className={`shrink-0 ${button}`}
            onClick={() => onOp(op)}
          >
            <Icon className="size-4" />
          </button>
        </Tip>
      ))}
      <DropdownMenu
        label={t`Batch actions`}
        open={props.labelPicker}
        onOpenChange={props.onLabelPicker}
        trigger={
          <button type="button" className={`shrink-0 ${button}`} aria-label={t`Batch actions`}>
            <Tag className="size-4" />
          </button>
        }
      >
        <BatchMenuItems {...props} />
      </DropdownMenu>
    </div>
  );
}
