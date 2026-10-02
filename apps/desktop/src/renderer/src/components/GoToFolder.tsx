import { useLingui } from "@lingui/react/macro";
import { fuzzyFolders, MAILBOXES } from "@openmail/core/schema";
import { useState } from "react";
import { accountName } from "../format";
import type { Account, Label } from "../../../shared/api";
import { ALL, OVERVIEW, MAILBOX_NAMES, type View } from "../view";
import { Dialog } from "./ui/Dialog";
import { CommandPicker } from "./ui/CommandPicker";

export function GoToFolder({
  labels,
  accounts,
  view,
  onView,
  onClose,
}: {
  labels: readonly Label[];
  accounts: readonly Account[];
  view: View;
  onView: (view: View) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState("");
  const space = view.space === OVERVIEW ? ALL : view.space;
  const items = [
    ...MAILBOXES.map((mailbox) => ({
      id: mailbox,
      name: i18n._(MAILBOX_NAMES[mailbox]),
      target: {
        space,
        ...(view.accountId ? { accountId: view.accountId } : {}),
        mailbox,
      } satisfies View,
    })),
    ...labels.map((l) => ({
      id: `${l.accountId}/${l.id}`,
      name: `${l.name} (${accounts.filter((a) => a.id === l.accountId).map(accountName)[0] ?? ""})`,
      target: {
        space,
        mailbox: "all",
        label: { accountId: l.accountId, id: l.id },
      } satisfies View,
    })),
  ];
  const found = fuzzyFolders(items, query, (item) => item.name);
  const pick = (id: string) => {
    const item = items.find((f) => f.id === id);
    if (item) {
      onView(item.target);
      onClose();
    }
  };
  return (
    <Dialog aria-label={t`Go to folder`} onClose={onClose} className="w-[480px] overflow-hidden">
      <CommandPicker
        label={t`Go to folder`}
        query={query}
        onQuery={setQuery}
        items={found.map((item) => ({ id: item.id, label: item.name }))}
        onPick={pick}
      />
    </Dialog>
  );
}
