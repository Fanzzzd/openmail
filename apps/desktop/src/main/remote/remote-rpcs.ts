import { RpcGroup } from "effect/rpc";
import { MailRpcs } from "../../shared/rpc";
import { REMOTE_RPC_POLICY } from "../../shared/remote-policy";

export { REMOTE_RPC_POLICY, remoteDisposition } from "../../shared/remote-policy";

type MailRpc = RpcGroup.Rpcs<typeof MailRpcs>;
type RemoteTag = keyof typeof REMOTE_RPC_POLICY;
type RemoteRpc = Extract<MailRpc, { readonly _tag: RemoteTag }>;

const isRemoteRpc = (rpc: MailRpc): rpc is RemoteRpc => Object.hasOwn(REMOTE_RPC_POLICY, rpc._tag);

/** The RPC group a remote client can reach. Denied RPCs have no handler at all. */
export const RemoteRpcs = RpcGroup.make(...[...MailRpcs.requests.values()].filter(isRemoteRpc));
