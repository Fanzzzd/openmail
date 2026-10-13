import { Effect } from "effect";
import { NodeRuntime } from "./runtime.js";
import { parseRawDraft as draft } from "../../compose/drafts.js";
import { invitesFromRaw as invites } from "../../calendar/invites.js";
import { inlineMediaFromRaw as media } from "../../mime/attachments.js";
import { imageAttachment as image } from "../../compose/compose-images.js";
export * from "../../compose/drafts.js";
export * from "../../calendar/invites.js";
export * from "../../mime/attachments.js";
export * from "../../compose/compose-images.js";
export { downloadRemoteImage } from "./image-network.js";
export const parseRawDraft = (...args: Parameters<typeof draft>) =>
  draft(...args).pipe(Effect.provide(NodeRuntime));
export const invitesFromRaw = (...args: Parameters<typeof invites>) =>
  invites(...args).pipe(Effect.provide(NodeRuntime));
export const inlineMediaFromRaw = (...args: Parameters<typeof media>) =>
  media(...args).pipe(Effect.provide(NodeRuntime));
export const imageAttachment = (...args: Parameters<typeof image>) =>
  image(...args).pipe(Effect.provide(NodeRuntime));
