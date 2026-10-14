/**
 * The app's one IPC surface: Effect RPC between the renderer and the main
 * process. Every payload, result and error is a schema, so both sides decode
 * what crosses the boundary and errors arrive with their tag intact.
 *
 * The RPCs live in `rpcs/` by domain; this file joins them into one group.
 */
import { RpcGroup } from "effect/rpc";
import { AppRpcs } from "./rpcs/app";
import { AiRpcs } from "./rpcs/ai";
import { AccountRpcs } from "./rpcs/accounts";
import { CalendarRpcs } from "./rpcs/calendar";
import { ContactRpcs } from "./rpcs/contacts";
import { ReadingRpcs } from "./rpcs/reading";
import { AttachmentRpcs } from "./rpcs/attachments";
import { OrganizeRpcs } from "./rpcs/organize";
import { ChangeRpcs } from "./rpcs/changes";
import { ComposeRpcs } from "./rpcs/compose";
import { DesktopRpcs } from "./rpcs/desktop";
import { RemoteAccessRpcs } from "./rpcs/remote";
import { SyncRpcs } from "./rpcs/sync";

export { ConnectInput } from "./rpcs/accounts";
export { PrintHeadings } from "./rpcs/reading";

export class MailRpcs extends RpcGroup.make(
  ...AppRpcs,
  ...AiRpcs,
  ...AccountRpcs,
  ...CalendarRpcs,
  ...ContactRpcs,
  ...ReadingRpcs,
  ...AttachmentRpcs,
  ...OrganizeRpcs,
  ...ChangeRpcs,
  ...ComposeRpcs,
  ...DesktopRpcs,
  ...RemoteAccessRpcs,
  ...SyncRpcs,
) {}
