import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { Account, Mailbox } from "../../shared/api";

/** "overview", "all", or a profile id. Spaces switch like Arc spaces. */
export type SpaceId = string;
export const OVERVIEW = "overview";
export const ALL = "all";

export interface View {
  space: SpaceId;
  /** One account inside the space; unset means every account in it. */
  accountId?: string;
  mailbox: Mailbox;
  /** A Gmail category (no account) or a user label / Outlook folder (with its account). */
  label?: { id: string; accountId?: string };
}

export type Filters = import("@openmail/core/schema").ListFilters;
/** Mailbox names; render with `i18n._(MAILBOX_NAMES[mailbox])`. */
export const MAILBOX_NAMES: Record<Mailbox, MessageDescriptor> = {
  inbox: msg`Inbox`,
  snoozed: msg`Snoozed`,
  important: msg`Important`,
  starred: msg`Starred`,
  sent: msg`Sent`,
  drafts: msg`Drafts`,
  spam: msg`Spam`,
  trash: msg`Trash`,
  all: msg`All Mail`,
};

export const CATEGORY_NAMES: Record<string, MessageDescriptor> = {
  CATEGORY_PERSONAL: msg`Primary`,
  CATEGORY_SOCIAL: msg`Social`,
  CATEGORY_PROMOTIONS: msg`Promotions`,
  CATEGORY_UPDATES: msg`Updates`,
  CATEGORY_FORUMS: msg`Forums`,
};

/** Accounts that belong to a space. */
export function spaceAccounts(space: SpaceId, accounts: readonly Account[]): readonly Account[] {
  accounts = accounts.filter((a) => a.enabled !== false);
  if (space === ALL || space === OVERVIEW) return accounts;
  return accounts.filter((a) => a.profileId === space);
}

/** Account ids a list query is limited to; undefined means no limit. */
export function scopeAccountIds(view: View, accounts: readonly Account[]): string[] | undefined {
  if (view.label?.accountId)
    return accounts
      .filter((a) => a.enabled !== false && a.id === view.label?.accountId)
      .map((a) => a.id);
  if (view.accountId)
    return accounts.filter((a) => a.enabled !== false && a.id === view.accountId).map((a) => a.id);
  if (view.space === ALL || view.space === OVERVIEW) return undefined;
  return spaceAccounts(view.space, accounts).map((a) => a.id);
}
