import { MailClient } from "../../state/rpc";
import { Keys } from "../../state/keys";

export const aiSettingsAtom = MailClient.query("AiSettings", undefined, {
  reactivityKeys: [Keys.ai],
});
