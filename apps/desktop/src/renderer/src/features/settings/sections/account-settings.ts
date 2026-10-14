import type { Account, AccountSettings } from "@openmail/core/schema";

/** A toggle changes only the persisted switch; local appearance edits need Save. */
export function accountSettingsInput(
  account: Account,
  change:
    | { kind: "toggle"; enabled: boolean }
    | {
        kind: "appearance";
        description: string;
        color: string | null;
        imapAuthservId?: string | null;
        imapSenderName?: string;
      },
): AccountSettings {
  return change.kind === "toggle"
    ? {
        enabled: change.enabled,
        description: account.description ?? "",
        color: account.color ?? null,
      }
    : {
        enabled: account.enabled !== false,
        description: change.description,
        color: change.color,
        ...(account.imap && change.imapAuthservId !== undefined
          ? { imapAuthservId: change.imapAuthservId }
          : {}),
        ...(account.imap && change.imapSenderName !== undefined
          ? { imapSenderName: change.imapSenderName }
          : {}),
      };
}

/** Guard rapid clicks before the mutation's pending state reaches React. */
export async function runAccountMove(
  lock: { current: boolean },
  send: () => Promise<unknown>,
): Promise<void> {
  if (lock.current) return;
  lock.current = true;
  try {
    await send();
  } finally {
    lock.current = false;
  }
}
