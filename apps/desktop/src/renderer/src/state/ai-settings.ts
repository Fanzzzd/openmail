import { MailClient } from "../rpc";
import { Keys } from "./keys";

export const aiSettingsAtom = MailClient.query("AiSettings", undefined, {
  reactivityKeys: [Keys.ai],
});
