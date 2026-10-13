import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

const AUDIT_ACTION_NAMES: Record<string, MessageDescriptor> = {
  read: msg`Mark read/unread`,
  star: msg`Star`,
  important: msg`Important`,
  archive: msg`Archive`,
  inbox: msg`Move to Inbox`,
  trash: msg`Delete`,
  spam: msg`Report spam`,
  label: msg`Label`,
  send: msg`Send`,
  send_failed: msg`Send failed`,
  draft: msg`New draft`,
  discard_draft: msg`Discard draft`,
  proposed: msg`Suggested`,
  approve: msg`Approve suggestion`,
  reject: msg`Reject suggestion`,
  denied: msg`Denied`,
  removeAccount: msg`Remove account`,
  connect: msg`Connect account`,
};

/** The Activity tab's name for a logged action. Actions without a name never show their raw id. */
export function auditActionName(i18n: I18n, action: string): string {
  const name = Object.hasOwn(AUDIT_ACTION_NAMES, action) ? AUDIT_ACTION_NAMES[action] : undefined;
  return i18n._(name ?? msg`Other action`);
}
