import { Cause, Match } from "effect";
import type { AsyncResult } from "effect/reactivity";
import type { RpcClientError } from "effect/rpc";

import type { MailError } from "../../shared/api";

/** What an RPC call can fail with: the main process's typed errors, or the transport. */
export type AppError = MailError | RpcClientError.RpcClientError;

const THINGS = { account: "账户", proposal: "建议", message: "邮件", profile: "空间" } as const;
const CLIENTS = { gmail: "Google", outlook: "Microsoft" } as const;

/** One short sentence for the person, per error tag. */
export const errorText = Match.typeTags<AppError, string>()({
  AuthError: (e) => `服务器拒绝了登录。${e.message}`,
  ClientNotConfigured: (e) => `还没有填写 ${CLIENTS[e.provider]} 的 OAuth 客户端。`,
  NotFound: (e) => `找不到这个${THINGS[e.what]}。`,
  PermanentError: (e) => `服务器拒绝了这个操作：${e.message}`,
  ProviderError: (e) => `暂时连不上邮件服务器：${e.message}`,
  InvalidInput: (e) => e.message,
  RpcClientError: () => "和后台的连接出错了。",
});

/** The typed error in `cause`, or a generic sentence for a defect or interruption. */
export function causeText<E extends AppError>(cause: Cause.Cause<E>): string {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" ? errorText(error.value) : "出了点问题，请再试一次。";
}

/** Error text for a failed result; null while it has not failed. */
export function resultError<A, E extends AppError>(result: AsyncResult.AsyncResult<A, E>) {
  return result._tag === "Failure" ? causeText(result.cause) : null;
}
