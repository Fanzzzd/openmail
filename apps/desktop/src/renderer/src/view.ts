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

/** List filters; they apply to every view until turned off. */
export interface Filters {
  unread: boolean;
  starred: boolean;
}

export const MAILBOX_NAMES: Record<Mailbox, string> = {
  inbox: "收件箱",
  important: "重要",
  starred: "星标",
  sent: "已发送",
  drafts: "草稿",
  spam: "垃圾邮件",
  trash: "已删除",
  all: "所有邮件",
};

export const CATEGORY_NAMES: Record<string, string> = {
  CATEGORY_PERSONAL: "主要",
  CATEGORY_SOCIAL: "社交",
  CATEGORY_PROMOTIONS: "推广",
  CATEGORY_UPDATES: "动态",
  CATEGORY_FORUMS: "论坛",
};

/** Accounts that belong to a space. */
export function spaceAccounts(space: SpaceId, accounts: readonly Account[]): readonly Account[] {
  if (space === ALL || space === OVERVIEW) return accounts;
  return accounts.filter((a) => a.profileId === space);
}

/** Account ids a list query is limited to; undefined means no limit. */
export function scopeAccountIds(view: View, accounts: readonly Account[]): string[] | undefined {
  if (view.label?.accountId) return [view.label.accountId];
  if (view.accountId) return [view.accountId];
  if (view.space === ALL || view.space === OVERVIEW) return undefined;
  return spaceAccounts(view.space, accounts).map((a) => a.id);
}
