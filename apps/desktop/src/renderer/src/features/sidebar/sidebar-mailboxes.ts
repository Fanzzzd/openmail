import type { ComponentType } from "react";
import type { Account, Mailbox } from "../../../../shared/api";
import {
  Bookmark,
  Clock,
  File,
  Inbox,
  Info,
  Mails,
  MessagesSquare,
  Send,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { scopeAccountIds, type View } from "../../lib/view";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { prefsAtom, unreadByLabelAtom } from "../../state/queries";

export type Icon = ComponentType<{ className?: string }>;

// Each mailbox gets its own icon color, as in Mimestream's sidebar.
export const MAILBOXES: { id: Mailbox; icon: Icon; color: string }[] = [
  { id: "snoozed", icon: Clock, color: "text-violet-600 dark:text-violet-400" },
  { id: "inbox", icon: Inbox, color: "text-blue-600 dark:text-blue-400" },
  { id: "important", icon: Bookmark, color: "text-orange-600 dark:text-orange-400" },
  { id: "starred", icon: Star, color: "text-amber-600 dark:text-amber-400" },
  { id: "sent", icon: Send, color: "text-emerald-600 dark:text-emerald-400" },
  { id: "drafts", icon: File, color: "text-sky-600 dark:text-sky-400" },
  { id: "spam", icon: ShieldAlert, color: "text-orange-600 dark:text-orange-400" },
  { id: "trash", icon: Trash2, color: "text-red-600 dark:text-red-400" },
  { id: "all", icon: Mails, color: "text-violet-600 dark:text-violet-400" },
];

export const CATEGORY_ICONS: Record<string, Icon> = {
  CATEGORY_PERSONAL: User,
  CATEGORY_SOCIAL: Users,
  CATEGORY_PROMOTIONS: Tag,
  CATEGORY_UPDATES: Info,
  CATEGORY_FORUMS: MessagesSquare,
};

const NO_COUNTS: Readonly<Record<string, number>> = {};

/**
 * Unread counts by label in the accounts the view's mailboxes cover, for
 * their badges; with `within`, only of mail that also has that label.
 */
export function useMailboxCounts(view: View, accounts: readonly Account[], within?: string) {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const scope = scopeAccountIds({ ...view, label: undefined }, accounts);
  return AsyncResult.getOrElse(
    useAtomValue(unreadByLabelAtom(scope, within, prefs?.threadGrouping !== false)),
    () => NO_COUNTS,
  );
}
