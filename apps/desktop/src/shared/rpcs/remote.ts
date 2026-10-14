import { RemoteAccessView } from "../remote-access";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Remote access over the person's tailnet. Desktop only: none of these is on the remote allowlist. */
export const RemoteAccessRpcs = [
  Rpc.make("RemoteAccess", { success: RemoteAccessView, stream: true }),
  Rpc.make("RefreshRemoteAccess"),
  Rpc.make("SetRemoteAccess", { payload: { enabled: Schema.Boolean }, error }),
  Rpc.make("SetRemoteAllowlist", {
    payload: { logins: Schema.Array(Schema.String.check(Schema.isMaxLength(512))) },
    error,
  }),
  Rpc.make("SetRemoteService", {
    payload: { service: Schema.String.check(Schema.isMaxLength(80)) },
    error,
  }),
  Rpc.make("DisconnectRemoteSession", {
    payload: { id: Schema.String.check(Schema.isMaxLength(128)) },
  }),
] as const;
