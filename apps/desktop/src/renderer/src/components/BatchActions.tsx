import { Trans, useLingui } from "@lingui/react/macro";
import { Archive, Mail, MailOpen, Star, Tag, Trash2 } from "lucide-react";
import type { Account, Label, MailOp, ThreadSummary } from "../../../shared/api";
import { DropdownMenu, MenuCheckboxItem, MenuItem, MenuSeparator } from "./ui/Menu";
import { Tip } from "./ui/Tip";

interface Props {
  rows: readonly ThreadSummary[];
  accounts: readonly Account[];
  labels: readonly Label[];
  onPermanentDelete?: (() => void) | undefined;
  onOp: (op: MailOp, accountId?: string) => void;
}

/** Labels belong to an account; a folder choice never reaches another account. */
export function BatchMenuItems({ rows, accounts, labels, onOp, onPermanentDelete }: Props) {
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
          if (!available.length) return null;
          return (
            <div key={account.id}>
              <MenuSeparator />
              <div className="px-2 py-1 text-xs text-neutral-500">
                {account.email} · {account.provider === "gmail" ? t`Labels` : t`Move to folder`}
              </div>
              {available.map((label) => (
                <MenuCheckboxItem
                  key={label.id}
                  checked={selected.every((row) => row.labels.includes(label.id))}
                  onCheckedChange={(value) =>
                    onOp(
                      {
                        kind: "label",
                        labelId: label.id,
                        value: account.provider === "gmail" ? value : true,
                      },
                      account.id,
                    )
                  }
                >
                  {label.name}
                </MenuCheckboxItem>
              ))}
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
  },
) {
  const { t } = useLingui();
  const { rows, onOp } = props;
  const count = rows.length;
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
    "rounded-md p-1.5 text-neutral-500 hover:bg-black/5 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:bg-white/10";
  return (
    <div className="flex items-center gap-0.5">
      <span className="mr-2 text-sm text-neutral-500">
        <Trans>{count} selected (loaded)</Trans>
        {props.canLoadMore && (
          <span className="ml-2">
            {props.moreNotLoaded === null ? (
              <Trans>More messages not loaded</Trans>
            ) : (
              <Trans>{props.moreNotLoaded} more not loaded</Trans>
            )}
          </span>
        )}
      </span>
      {actions.map(({ icon: Icon, label, op }) => (
        <Tip key={op.kind} label={label}>
          <button type="button" aria-label={label} className={button} onClick={() => onOp(op)}>
            <Icon className="size-4" />
          </button>
        </Tip>
      ))}
      <DropdownMenu
        open={props.labelPicker}
        onOpenChange={props.onLabelPicker}
        trigger={
          <button type="button" className={button} aria-label={t`Batch actions`}>
            <Tag className="size-4" />
          </button>
        }
      >
        <BatchMenuItems {...props} />
      </DropdownMenu>
    </div>
  );
}
