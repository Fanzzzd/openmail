# 同步与发送结果

迁移 39 清除 Outlook 的完整和 Inbox delta 游标，以补取 `inferenceClassification`。下次同步会重拉同步窗口内的邮件及消息文本一次，窗口外缓存保留，但分类不会自动补齐；未知分类暂按 Focused 处理，用户可直接更改分类。

UIDNEXT 回退且 UIDVALIDITY 未变时，旧 UID 已不可信。core 先失效远端草稿引用，把旧队列操作改成带无效 provider ID 的 `reconcile`，并撤销旧撤销记录与待审批提议。UID 身份失效会隔离保留全部旧缓存，用 Message-ID 验证；重新发现的邮件使用新的本地世代 ID，不复用旧句柄。此情况不按旧 UID 自动重映射。阅读视图在消息查询返回不存在时清除旧内容。IMAP 全量同步和普通收件箱轮询先拉取、后推送；按账户与推送队列互斥，其他账户操作不等拉取结束。UIDVALIDITY 改变时仍按 Message-ID 重映射，每个旧行在一次拉取中最多使用一次。手机 OS 后台任务仅增量拉取，不推送队列。实现见 [store.ts](../packages/core/src/store/store.ts)、[mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts)、[Node IMAP](../packages/core/src/platform/node/imap/adapter.ts)和[手机 IMAP](../packages/core/src/platform/react-native/imap.ts)。

文件夹失效后，尚未同步的本地改动会被丢弃，包括标签、已读、星标、稍后提醒和排队的远端草稿删除；相关操作只保留无效 ID 的清理记录，孤立提醒行会删除。推送在 SELECT 后核对保存的 UIDVALIDITY 和 UIDNEXT 下界；发现回退便返回永久错误，等待重新同步。

UIDVALIDITY 变了而下一轮拉取还没重映射时，桌面推送按排队时记下的 Message-ID 在新 UIDVALIDITY 下搜索。找到唯一一封就在 `ProviderError.remap` 里返回新 ID，队列改名后立即重试；找不到则返回可重试的 ProviderError，等拉取重映射。手机推送直接返回可重试错误。`fetchMessage` 对旧 ID 也返回可重试错误，reconcile 不再因此删除缓存行，所以 90 天重建窗口外的旧邮件保留，在用户第一次操作时按 Message-ID 改名。`remapProviderIds` 把改名后的排队操作设为立即可重试。回归见 [imap-uidvalidity-push.test.ts](../packages/core/src/platform/node/imap-uidvalidity-push.test.ts)。

## IMAP 复制、移动与草稿

两端移动统一先 COPY、确认目标身份，再删除源副本。UIDPLUS 可定向清除源 UID；否则只加 `\Deleted`，不执行全局 EXPUNGE。两端同步、历史拉取与服务端搜索把 `\Deleted` 邮件视为不存在，避免恢复源文件夹副本。没有 UIDPLUS 时，服务器原件待其他客户端或服务器清除；永久删除仍要求 UIDPLUS。其他客户端撤销 `\Deleted` 后，旧 UID 要到重置游标后的完整窗口重扫才会重新出现。无 CONDSTORE 时，已有 UID 的标记最多每十分钟完整扫描一次。openmail 推送 `\Seen` 或 `\Flagged` 成功后，core 同时更新完整游标和收件箱游标中该 UID 的标记记录；否则其他设备随后改回原值时，服务器状态与旧记录相同，不会产生 Flags 变更。

COPY 前按排队操作、源 provider ID 和目标文件夹持久记录 issued 进度，成功回复后记录 accepted。首次操作正常复制，即使目标已有相同 Message-ID；重试才按进度查询目标，查到后只重做源副本删除。明确拒绝会清除对应进度；丢失回复时保留。源、目标均不存在且没有进度时返回 PermanentError，终止操作并 reconcile；有进度但结果未确认时继续等待。批量操作逐封记录，不能把一封的进度当作另一封的进度。

COPYUID 缺失时按 Message-ID 查目标 UID。已有 Message-ID 但 UID 未确认时保留源副本和队列；没有 Message-ID 且已确认 COPY 成功时完成源删除，排队 reconcile，并暂停本轮对旧 ID 的后续操作，由下一次拉取恢复缓存。重试前核对源邮件身份；比较时去掉尖括号和空白。身份不符时停止操作，failed_ops 显示 “Message identity changed”，在线 reconcile 恢复当前服务器消息；离线保留缓存并排队 reconcile，不复制或删除复用 UID 的消息。`mailbox.organize.perform` 的 IMAP copy 直接进入队列，不使用移动目标判断；非 IMAP 的 copy 在任何入队前返回 InvalidInput，混合账户选择也不执行部分复制。手机特殊文件夹同时匹配路径末级名称，例如 `INBOX.Sent`；CREATE 的 `NO [ALREADYEXISTS]` 视为已存在。

Node IMAP 标记、复制和删除返回 false 时按 ProviderError 重试；PERMANENTFLAGS 禁止所需标记时永久失败。草稿 APPEND 前记录 Message-ID，重试先查已追加副本，避免重复追加。退避期间的编辑或手动重试保留这份身份和进度；发现内容已变则替换恢复的副本，最终只保留最新的可见副本。恢复的 UID 与旧引用相同时不删除该副本。丢弃草稿或保留本地副本时，排队按已记录的 Message-ID 清理未确认副本；切换账户时在原账户清理，不把旧身份用于新账户。新草稿 UID 未知时保留旧副本并失败；新关联已确定而旧副本清理失败时，排队 deleteDraft 重试清理。

实现见 [Node IMAP](../packages/core/src/platform/node/imap/adapter.ts)、[手机 IMAP](../packages/core/src/platform/react-native/imap.ts)与 [Store](../packages/core/src/store/store.ts)。回归入口见[测试](testing.md#outbound-operations-and-sending-regressions)。

## 出站操作队列

`pending_ops` 在失败后保存 retry_at，首次等待五秒，随后指数退避，最长一小时，每次等待随机提前最多 20%；刷新跳过尚未到期的操作，也不越过同一邮件的前置失败操作。断网、传输失败、429／deferred 和 5xx 不按重试次数丢弃。PermanentError 立即终止；普通操作再次推送失败且排队满七天时过期。reconcile 在账户不可达时一直保留。AuthError 暂停账户、标记重新登录并释放认领，不增加失败次数；只读会话不推送队列。

认领有效期两分钟，长推送每三十秒续租。每次认领有独立 token，结算及写入远端草稿关联时核对 token。续租或本地重映射失败只处理当前操作，无关操作及拉取继续；旧进程不能结算新进程认领的操作。迟到上传产生的独立草稿副本会清理，清理失败排队删除；当前草稿已引用的副本保留。

迁移 36 增加重试时间、认领 token、Message-ID、复制进度和草稿 APPEND 身份；既有排队操作从缓存补全 Message-ID。推送中终止的非 reconcile 操作和发送警告进入 failed_ops，桌面与手机按类别显示计数、操作、主题、发件人及原因，直到用户关闭提示。Graph 写入的 400、404、409、413、415、422 和 `403 ErrorAccessDenied` 为永久错误，界面显示简短原因，不显示 Graph JSON。

实现见 [mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts)、[store.ts](../packages/core/src/store/store.ts)、[db/migrations.ts](../packages/core/src/db/migrations.ts)和 [Outlook](../packages/core/src/providers/outlook/outlook.ts)。

## 发送结果

每次 HTTP 请求的重试等待累计不超过 60 秒。Graph 收到 429／5xx 的 Retry-After 时立即更新账户拉取截止时间，后续 JSON、MIME 和只读 batch 请求均检查该截止时间，不等当前请求重试耗尽才阻止其他请求。Outlook 的发送、回复草稿准备与发送确认使用独立请求许可，不排在限流的拉取后面。IMAP 操作中断时关闭连接并从推送池移除；手机端同一连接的命令串行执行。

Gmail 和 Graph 的发送 POST 不自动重试。Message-ID 使用随机本地部分和发件人域名，不发送自定义追踪头。连接中断或服务端返回 5xx 后，core 在约 30 秒内以递增间隔查询“已发送”。查到副本才报告成功；仍无法确定时返回 `SendUncertain`，保留草稿，并在本地持久保存重发保护。再次发送同一草稿必须由 app 中的用户确认已检查“已发送”。此保护在重启后继续生效。

Gmail 官方文档规定提交 RFC 2822 MIME，并支持 `rfc822msgid` 搜索，但没有承诺保留客户端设置的 Message-ID。core 先查询完整 ID；没有结果时，搜索提交前一分钟至提交后两分钟的 Sent 候选，读取 Message-ID metadata 并核对随机本地部分。不依赖未文档化的部分 ID 搜索。若服务端连本地部分也重写，无法确认发送，继续保留重发保护。自动测试覆盖 ID 保留、域名改写、延迟副本和未找到副本；没有用真实账户发送探测邮件。参见 [发送邮件](https://developers.google.com/workspace/gmail/api/guides/sending)、[消息列表查询](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 搜索条件](https://support.google.com/mail/answer/7190)。

Graph 用 `internetMessageId` 查询 Sent。发送时的回复草稿创建结果不确定，只按提交时设置的 ID 查询 Drafts 并清理匹配的孤立草稿，不删除会话或创建时间匹配的候选。草稿准备失败也会清理已取得 ID 的草稿，发送成功后不会删除 Sent 副本。参见 [创建回复草稿](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)和 [更新草稿 Message-ID](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)。

IMAP SMTP 在 DATA 终止符已发出后丢失回复时，按 Message-ID 查询 Sent；未确认则返回 SendUncertain，保留草稿和重发保护。DATA 前的连接拒绝、超时或 greeting 失败属于明确失败；收到 5xx 拒绝也属明确失败，认证错误仍提示重新登录。SMTP 接受后保存 Sent 副本失败会重连重试 APPEND 一次；再次失败时显示副本缺失提示，不重新发送邮件。

Node SMTP 部分拒收会列出拒收地址，保留原草稿并启用重发保护。提示中的“仅向拒收收件人重发”创建新草稿，只保留拒收的 To／Cc／Bcc，保留消息文本及附件，不自动发送，也不修改原草稿。

发送确认实现见 [provider-send.ts](../packages/core/src/providers/provider-send.ts)、[Node IMAP](../packages/core/src/platform/node/imap/adapter.ts)和[手机 IMAP](../packages/core/src/platform/react-native/imap.ts)；失败提示经 Mailbox 的 listFailedOps、acknowledgeFailedOps 与 prepareRejectedResend 提供。

## 草稿与其他写入

创建草稿、附件、规则、标签／文件夹及会议响应的 POST 只对 429 自动重试，5xx 或响应丢失不重放。Gmail 的修改标签、trash、untrash POST 可重放；Calendar 的 `PATCH sendUpdates=all` 不重放通知。

草稿创建前，core 在既有 prefs 中保存客户端 Message-ID、尝试时间与查询未命中次数。客户端能确认请求尚未发出的 DNS／连接失败可直接重试。其他未确认创建先按 Gmail `in:drafts rfc822msgid:` 或 Graph `internetMessageId` 查草稿；查询至少三次未命中且尝试满两分钟，才重新创建。尝试时间只控制重试间隔，不用于识别服务器草稿。

Outlook 只在对应账户的 Drafts 文件夹中，凭精确的客户端 Message-ID 和 `isDraft=true` 证明草稿归属，才恢复编辑或清理未确认副本。多个命中或尚有续页时保留不确定状态；精确命中不受创建时间、修改时间或 conversationId 限制。会话、时间接近、看似未编辑、未关联本地草稿和唯一候选都不能证明归属，我们不猜测。Graph 在结果不确定的 createReply 中替换客户端 Message-ID 时，恢复会按未命中处理并在重试条件满足后重新创建，清理会保留未知副本。因此空的重复回复草稿可能留在 Drafts，需要用户删除；宁可留下副本，也不覆盖或删除其他客户端写好的内容。回复全部与转发遵守同一规则。

丢弃或发送本地草稿时，若创建日志仍标为已尝试，则先在同一事务中按日志 Message-ID 排队清理服务器草稿，再清除日志。创建日志与远端引用写入核对当前认领 token，旧 worker 不覆盖新 owner；已取得创建响应中的新 ID 便持久保存远端引用，后续 PATCH 或附件失败仍返回该 ID 和同步错误。Graph 回复、回复全部及转发创建后 PATCH 客户端 Message-ID。Outlook 普通更新仅在初次 PATCH 返回 404 时重建；附件阶段的 404 不重建。forward 替换后的旧草稿删除失败，交给持久 `deleteDraft` 队列处理。

Outlook 附件上传结果不确定时，读取全部附件页并核对文件名、内容字节及 Content-ID。恢复创建时只添加缺失附件。打开服务器草稿时即保存 changeKey 和 lastModifiedDateTime；远端版本只保存 changeKey 与服务端修改时间，不用本地时钟补值。更新前 GET 比较，只有版本不同且服务端修改时间晚于最后写入时，才另存本地版本并报告冲突。PATCH 后的部分失败会重读版本；读取失败则清除旧 changeKey，避免把本次写入当作其他客户端修改。Graph 的[消息更新文档](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)未承诺 If-Match，当前比较仍存在 GET 与 PATCH 之间的竞态。

草稿更新的响应可能丢失。这时服务器已改了版本，客户端却没收到新 changeKey 或新 message ID。core 在发送 PATCH（Outlook）或 PUT（Gmail）前把这次写入内容的 SHA-256 存进 `DraftRemote.writeNonce`，写入本身也带上它。Outlook 用扩展属性 `OpenmailDraftWrite`，Gmail 用邮件头 `X-Openmail-Draft-Write`。下次保存时，如果版本比较判为冲突，适配器再读一次远端的 nonce；它等于本次内容的指纹或已存的 `writeNonce` 时，这次改动是自己的，原地更新，不另存草稿、不报冲突。确认保存成功的 `setDraftRemote` 清掉 `writeNonce`。回归见 [outlook-draft-lost-response.test.ts](../packages/core/src/providers/outlook/outlook-draft-lost-response.test.ts)和 [gmail-draft-lost-response.test.ts](../packages/core/src/providers/gmail/gmail-draft-lost-response.test.ts)。

### Outlook 大附件

规则核对于 2026-10-07：

- [Graph Outlook 上传说明](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)与 [createUploadSession](https://learn.microsoft.com/en-us/graph/api/attachment-createuploadsession?view=graph-rest-1.0)规定：小于 3 MB 的文件直接添加，3–150 MB 的文件使用上传会话，按顺序 PUT 字节范围。上传 URL 已包含授权，PUT 和恢复查询不附带 Authorization，也不改写 URL。最后一块返回 201，普通进度返回 200 和 nextExpectedRanges。
- Outlook 文档建议每块小于 4 MB。[320 KiB 整数倍及小于 60 MiB](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0#upload-bytes-to-the-upload-session)属于 OneDrive 的规则，不能拿 60 MiB 作为 Outlook 的块上限。当前统一选用 9 × 320 KiB，即 2,949,120 字节，最后一块可更短。
- [Graph 普通写请求上限](https://learn.microsoft.com/en-us/graph/use-the-api#http-methods)是 4 MB，包含 JSON 和 Base64 开销。单个小文件仍直接上传；多个小文件合计超过请求上限时分别添加到草稿。消息文本与邮件头本身超限仍报错。
- [Outlook.com 专用说明](https://support.microsoft.com/en-us/support/known-issues/unable-to-attach-files-in-outlook-com)规定总邮件上限为 25 MB，包含消息文本、插入文件和附件；[发送限制页](https://support.microsoft.com/en-us/outlook/sending-limits-in-outlook-com)也列出 25 MB 附件上限。Graph 文档中的默认 35 MB 指可由管理员配置的 Exchange Online 邮箱，不适用于当前仅支持的个人账户。预检计入 Base64、换行、消息文本及 256 KiB 邮件头余量；最终仍由服务器判定大小。
- [attachment 类型说明](https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0)将 itemAttachment 限制在 3 MB 以内。上传会话只支持 file；3 MB 及以上的 message/rfc822 明确拒绝。小 EML 发送保留原 MIME 路径，完整请求仍须小于 4 MB。

发送大文件先创建独立发送草稿。在 prefs 的 `send-prepare:<本地草稿 ID>` 中记录随机 Message-ID 和 creating／preparing／sending 阶段，不保存上传 URL 或附件字节。创建响应丢失或准备阶段中断后，只采用 Drafts 中唯一且无续页的精确 Message-ID 命中。未命中时先对 Sent 做最多三次有界查询；查询失败不重建。已经在网页发送的副本算投递成功，否则用同一个 Message-ID 重建草稿。Graph 回复创建若替换 Message-ID 且 PATCH 前中断，可能留下未知空草稿，但不会自动发送这些副本。sending 在提交前持久化；普通重试只查 Sent，不再次提交。用户明确确认 Send again 时，直接发送与撤销队列都在同一事务中先按旧 Message-ID 排队清理草稿，再清除旧准备记录，按新发送意图实际重发。明确拒绝发送可回到 preparing，上传失败保留已识别草稿供重试。没有持久日志的直接调用失败时，仅删除精确身份匹配的临时草稿。丢弃本地草稿会排队按 Message-ID 清理，Sent 副本不匹配 Drafts 清理条件。

每次上传按 nextExpectedRanges 继续。PUT 失败先查询会话状态；最终响应丢失时逐块核对已附加内容，避免重复附件。每块超时按至少 20 KiB/s 传输速度加 30 秒余量计算；不凭本地时钟和服务端到期时间跳过 PUT，只有请求返回 404／410 或会话已过期错误才重建，最多两次。放弃的上传会 DELETE 上传 URL，不附带 Authorization。恢复查询使用 GET 上传 URL，并接受 nextExpectedRanges／NextExpectedRanges 两种写法，依据[微软 SDK 实现](https://github.com/microsoftgraph/msgraph-sdk-javascript/blob/dev/src/tasks/LargeFileUploadTask.ts)。完整传输失败则由既有草稿／发送错误路径处理，不改变撤销窗口、outbox 认领或 pending-op 规则。排队前与发送时都计入消息文本；固定大小和上传错误通过 RPC 精确白名单及 Lingui 显示，服务商任意错误文本仍被过滤。

上传仅解码当前块；已有 Base64 源由 compose 模型持有，不再构造完整二进制或大附件 JSON，上传前只规范化一次空白。恢复仅列附件元数据，按名称、类型、isInline／Content-ID 筛选后流式比较字节。Graph 的 size 是存储大小，不能作为内容身份：官方示例上传 3,483,322 字节后，GET 返回 3,640,066 字节。草稿保存沿用创建日志与远端版本；附件未变时不上传。适配器缓存已核验的附件 ID 与分块内容指纹，自身仅修改消息文本的 PATCH 保留缓存，读到远端版本变化或重启后重新核验。回归见 [outlook-upload.test.ts](../packages/core/src/providers/outlook/outlook-upload.test.ts)，包含膨胀 size、最终 PUT 响应丢失、各阶段恢复、确认重发、慢速与时钟偏差、10 MB 分块、100 MB 内存边界和服务器草稿重新打开后保存。全部 Graph 测试使用假的 HTTP 服务，未调用真实 Microsoft API。

规则创建结果不确定时，重读并匹配条件、动作和排除条件。Gmail 更新规则必须先核对新规则；仍未确认时保留原规则恢复记录，不自动恢复或重放创建。会议响应重读 responseStatus 或自身 attendee 状态，匹配后才报告成功。标签／文件夹创建冲突按完整名称重读；Gmail 同时处理 400 和 409，只有找到同名用户标签才报告成功。Gmail 官方[标签说明](https://developers.google.com/workspace/gmail/api/guides/labels)明确保留名称冲突可返回 400，未规定重复自定义名称的状态码。

Gmail 从 Trash 移动前先验证目标标签。untrash 后修改失败会恢复 Trash；恢复也失败则报告位置需要核对。

## 持久发送意图

桌面撤销窗口由 core 持久保存消息、截止时间、所属窗口与发送后归档选项，等待任务属于 Mailbox Layer。renderer 断开不取消发送；用户批准退出、重载或关闭撰写窗口时，取消对应 waiting 项并保留草稿。意外重启后的 waiting 项仅由桌面主进程恢复，CLI／MCP 不恢复或刷新这些发送。桌面意图超过截止时间两分钟时改为 retryable 并显示失败提示，保留草稿供用户重发；启动恢复及发送认领时均检查截止时间。撤销向 core 取消 waiting 意图，已经认领的发送不能撤销；成功撤销会中断 core 等待任务；完成的 core 等待任务自行移出 worker 表。窗口只取消属于自己的 waiting 意图；没有 owner 的意图只由全局退出处理。renderer 按每次发送的 token 清理待发状态；撤销进行中先等取消结果，只有成功取消才隐藏发送结果，取消失败仍显示实际成功或失败；服务端拒绝撤销时清除 toast 和 Undo 操作，保留待发状态直至发送结束。独立发送 ID 防止旧计时器发送同一草稿的新意图。同一草稿已有 waiting／sending 项时，直接发送会拒绝重复提交。

outbox 在同一事务中重读 waiting、认领为 sending 并保存重发保护。锁只覆盖认领与结果事务，provider 发送期间可排队或撤销其他草稿。桌面普通发送也在调用 provider 前保存保护；全部收件人投递成功才清理保护，适配器返回 SendUncertain 才保留保护，其他错误包括发送前的请求失败均清除保护。SMTP 部分拒收沿用发送结果一节的保护，并保留 failed outbox 项。outbox 的明确失败标为 retryable，手机端“重试发送”打开保留草稿供用户检查；结果不确定或进程在发送中退出，保留保护，不能自动重发。启动时将中断的 sending 项改为 failed，用户确认后可重新排队。桌面发送失败及中断通过 failed_ops 显示提示，包括恢复任务和已断开的 renderer。上述状态复用 prefs，没有新增迁移。

## 重置删除保护

重置的 keep 集合只覆盖本轮列出的范围。Outlook 初始同步和 410 重启按最近 90 天的 `receivedDateTime` 过滤并倒序分页。delta URL 不带 `$top`；初始请求、nextLink、deltaLink 每次都发送 `Prefer: IdType="ImmutableId", odata.maxpagesize=50`，普通列表端点仍可用 `$top`。删除候选使用同一起点，窗外消息保留。过滤 delta 最多返回 5,000 条，不能据此证明缺失邮件已删除。窗口内所有缺失项都要验证；缺少最终 deltaLink 时保留旧游标，下一轮重新列举。[Graph delta 文档](https://learn.microsoft.com/en-us/graph/delta-query-messages)说明了过滤、排序、条数上限和续页链接。

Gmail history-404 恢复列出最近 90 天，恢复分页不受初次同步的 2,000 条限制，Reset 仅覆盖相同日期范围。IMAP UIDVALIDITY 重建只检查 SINCE 日起的窗口；每个文件夹最多取最新 1,000 条，因此窗口内缺失项也须验证。已有 UID 的标记扫描仅清理明确扫描过的 ID。文件夹消失和 UID 复用分别校验原文件夹身份与 Message-ID，不用新 UID 的存在证明旧消息仍在。

slice 62 移除了删除数量阈值。Reset、DeleteLabel 和 RebuildFolder 中所有未列入 keep 的删除候选都先入持久验证队列，即使只缺一封也须验证；不因列表标记完整或为空直接删除。持久队列的预算、续验与扫描规则见[过期缓存扫描](#过期缓存扫描)。Graph 每批最多 20 个只读请求，使用四个拉取许可，遵守内部请求的 Retry-After；发送许可保持独立。Gmail 用 minimal 批量读取，IMAP 用 UNDELETED UID SEARCH 和 Message-ID 搜索。确认消失才删除；找到同文件夹副本则保留，移到其他文件夹则更新归属。`sync-reset` 日志只记录账户、文件夹的哈希和计数。Outlook listing 仅在首次建游标、身份重置或 410 重启时记录；普通增量拉取不记为重置，空列表也保存最终 deltaLink。

保护已随 slice 56 合入。验证队列使用既有 prefs 持久化，无新增迁移；本地队列未验证完时继续保留缓存。只读会话允许这些存在性探测，包括只含 GET 子请求的 Graph batch。实现见 [sync-reset.ts](../packages/core/src/sync/sync-reset.ts)、[store-sync-reset.ts](../packages/core/src/store/store-sync-reset.ts)、[Outlook](../packages/core/src/providers/outlook/outlook.ts)、[Gmail](../packages/core/src/providers/gmail/gmail.ts)和 [read-only.ts](../packages/core/src/mailbox/read-only.ts)。回归见 [sync-reset.test.ts](../packages/core/src/sync/sync-reset.test.ts)和 [sync-reset-imap.test.ts](../packages/core/src/sync/sync-reset-imap.test.ts)。

Node IMAP adapter 将 ImapFlow SEARCH 返回的 false／undefined 视为 ProviderError，不转成空 UID 集合。首次拉取、增量、标记扫描、历史回填、服务端搜索和存在性验证共用此规则，搜索失败不能证明邮件消失。文件夹遗漏先核对 STATUS；只有明确 NotFound 且再次 LIST 仍缺失才确认删除，失败或隐藏文件夹保留旧状态。Outlook 同样先直接 GET 遗漏的文件夹，仅明确 404 才进入删除验证，其他结果保留旧游标。实现见 [Node IMAP](../packages/core/src/platform/node/imap/adapter.ts)、[Outlook](../packages/core/src/providers/outlook/outlook.ts)和 [store.ts](../packages/core/src/store/store.ts)，回归见 [imap.test.ts](../packages/core/src/providers/imap/imap.test.ts)及 [sync-reset-imap.test.ts](../packages/core/src/sync/sync-reset-imap.test.ts)。

## 失败后续传

Gmail 初次同步先取 `/profile` 的 historyId，开始拉取正文前保存游标 `initial:<historyId>`。重试时用这个 historyId，重新列出 ID，跳过已存储的消息，不再按 `format=full` 重取；完成后游标为原 historyId，之后的 history 覆盖两次尝试之间的变化。限流（429，或 Gmail 403 的 rateLimitExceeded、userRateLimitExceeded、totalQueryCostPerMinutePerUser）的 ProviderError 带 `reason: "quota"`。完整同步对它重试两次，等 30 s、60 s；服务器给出 Retry-After 时按它等，超过两分钟则交给下次定时同步。网络错误和 5xx 仍等 5 s、10 s。

Outlook 完整同步每完成一个文件夹，就保存一次带 `__partial` 标记的游标：已完成文件夹用新 delta 链接，其余沿用旧链接。保存前先把已见到但目标未列出的移除放进验证队列；重启的文件夹先发出 DeleteLabel，其 keep 集合不含已入队的 ID，避免把它们从队列中删掉。重试时，带标记游标中缺少链接的文件夹按重启处理。旧格式游标（没有不可变 ID 标记）要在全部文件夹之后 Reset，只在最后保存。同步遇到拉取失败时，先写入失败前已收到的变更，再报告失败，批缓冲中的检查点不会丢。

## 过期缓存扫描

完整同步后，stale sweep 每账户每小时最多运行一次。扫描时间和分页位置保存在 prefs，重启后沿用。只扫描服务端计数可用且 `local.total > server.total` 的文件夹。先取得所有文件夹的摘要计数，再在账户十秒预算的剩余时间内做可选复核。复核只用于 Gmail 类别／Drafts 和 Outlook Drafts，每个复核最多一秒；普通 Inbox 不枚举 ID。Gmail 只分页读取 ID，显式 includeSpamTrash=true，总数和未读各最多两页；摘要总数超过两页可计数的 1,000 条时直接跳过复核，总数列举触顶后不再列未读。Graph 用文件夹 messages 的 `$count=true`，分别查询总数和未读数。触顶、超时或复核失败保留已取得的摘要计数及 available 状态，仍可扫描旧行；只有原始摘要读取失败才标为服务商不可用。复核后不再多出的文件夹不进入逐项验证；仅未读数过多不触发扫描，因为 Graph 与 IMAP 的位置验证不读取当前标记。

扫描每账户每轮最多验证 500 个 ID，使用独立预算。重置和 Outlook 冲突验证仍共用每轮同步、所有账户合计 500 个 ID 的持久队列预算。扫描跳过队列中和本轮已验证的 ID，避免消耗重置预算或重复请求。失败和未验证行保留，扫描位置轮转，下一次满足小时频率时续验。已明确验证的扫描行在同一 prefs 状态保存 provider ID、Message-ID 和标签的组合哈希前 16 位，24 小时内跳过未变化的行；标签或身份变化会重新验证，重置队列不受这份记录限制。`incomplete` 只统计本轮没有明确结果的候选，确认仍在原文件夹的行计为完成。网络请求沿用服务商的锁和重试规则；批次重试耗尽后停止剩余批次，不绕过 Retry-After。

计数差只提供候选范围，清理复用上述服务器验证路径。验证结果先叠加待推送操作，保留本地未同步改动。Gmail drafts.list 只在有未缓存的孤立远端草稿候选时读取最多 500 条的一页，列出的 ID 可证明存在，未列出的 ID 仍须逐项验证；所有候选已缓存时不发起该请求。

Drafts 孤立草稿只统计已有 `remote_message_id`、`local_only=0`、`sync_error IS NULL` 且没有对应消息行的草稿，按远端消息 ID 去重；扫描候选使用相同规则。本地未上传、local-only 和同步失败的草稿不计入孤立远端行。404 清理继续保护有待处理 saveDraft 的草稿，不删除尚未上传的编辑内容。

Outlook 同轮出现同 ID 的更新和移除时，只要更新文件夹与移除文件夹重叠，就先把 ID 保存到持久验证队列，再保存游标。拉取不内联验证；随后按共享预算核对当前位置。限流、权限错误和没有明确答案的 ID 留在队列，后续同步续验。这覆盖从后处理文件夹移动到 Inbox、旧文件夹更新覆盖了新位置的情况。没有被任何文件夹列出的移除同样先入验证队列，不直接删除：文件夹 delta 的 `receivedDateTime` 起点在游标创建时固定，二月的邮件移入六月新建的文件夹后，新文件夹的 delta 不会列出它；验证读取 `parentFolderId` 后把它改到新文件夹。确实删除的邮件由验证确认为 gone 后删除，每 20 个删除多一个只读 batch 请求。Inbox 轮询不处理移除，也不逐个 GET 自定义文件夹；收件箱游标只保留 Inbox 的 delta 链接，文件夹删除仍由完整同步判定。

实现见 [sync-reset.ts](../packages/core/src/sync/sync-reset.ts)、[store-sync-reset.ts](../packages/core/src/store/store-sync-reset.ts)、[Outlook](../packages/core/src/providers/outlook/outlook.ts)和 [store-sync-health.ts](../packages/core/src/store/store-sync-health.ts)，回归见 [sync-stale.test.ts](../packages/core/src/sync/sync-stale.test.ts)、[sync-reset.test.ts](../packages/core/src/sync/sync-reset.test.ts)及 [outlook-sync-health.test.ts](../packages/core/src/providers/outlook/outlook-sync-health.test.ts)。

## 旧缓存邮件头回填

slice 66 在每账户完整拉取成功后，以及启用自动同步时的独立后台维护中回填 `rfc_message_id IS NULL OR headers_json IS NULL` 的旧行，按邮件日期、本地 ID 倒序，每批 20 行、每账户每轮最多 500 行。独立游标及完成时间保存在 `prefs` 的 `sync-headers:<account>`；每批补写与游标一起提交，重启后续跑。完成后停止请求。独立维护每十秒选择一个未完成账户，不等待 Graph delta 重建；与完整同步共用账户回填锁，IMAP 还须取得拉取锁，忙时跳过。无新增迁移。

Gmail 按共享账户请求许可串行 GET metadata，用 `metadataHeaders` 指定身份、引用链、投递、邮件列表及安全等缓存字段，集合见 [header-backfill.ts](../packages/core/src/sync/header-backfill.ts)。Graph `$batch` 每批最多 20 个 GET，显式 `$select=internetMessageId,internetMessageHeaders`，每轮最多 25 批，沿用 ImmutableId、拉取许可及内部请求的 Retry-After。Graph 成功响应省略或返回 null 邮件头时，缓存 `[]` 并推进游标，保留返回的 Message-ID；没有 Message-ID 也只扫描一次。请求失败的重试截止时间持久保存在回填状态，重启沿用；Graph 拉取请求共用账户限流截止时间，发送许可独立。[Graph 邮件头文档](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0#example-2-get-internet-message-headers)要求用 `$select` 获取邮件头。桌面和手机 IMAP 按文件夹分组，核对 UIDVALIDITY 和已知 UID 下界，只执行只读打开与 `UID FETCH BODY.PEEK[HEADER.FIELDS (...)]`，保留重复字段并展开折行。手机正常拉取也保存邮件头，避免继续产生缺头缓存。

补写只 UPDATE 两个缺失字段，不覆盖已有值，不改 rowid、标签、标记、线程或正文；FTS、词索引和消息派生触发器不监听这两列。只读会话允许远端读取及同步缓存补写。404、410、缺失 UID 或不安全的 IMAP 身份只跳过，留给普通同步与存在性验证；不删除邮件。前置存在性验证已推迟时跳过同步尾部回填，独立维护也受账户 Retry-After 约束。回填请求失败、限流超出等待预算或缺失回复时停止本轮，保留未完成批次的游标；邮件头没有 Message-ID 也可完成扫描。自动同步维护只处理已有同步缓存的账户，手机 OS 增量后台任务不运行。

实现见 [header-backfill.ts](../packages/core/src/sync/header-backfill.ts)、[store-header-backfill.ts](../packages/core/src/store/store-header-backfill.ts)和 [mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts)。回归覆盖四种适配器的读取、重复与折行字段、命名空间保护、限流和只读规则；[持久化测试](../packages/core/src/platform/node/header-backfill.test.ts)覆盖各服务商的 500 行预算、数据库关闭重开续跑、完成后停止、账户隔离、标签／标记保持及 FTS 无额外写入；假 Graph 验证 3,840 行在八轮内完成，含缺头、缺 ID、原有 ID、重试截止时间和 delta 阻塞。

同步重置计数由 `logSyncReset` 记录为 Info。桌面日志桥将已识别的 `sync-reset` 和 `provider-failure` 事件各记录一次，不再为其额外产生 `runtime-warning`。真正的运行时警告／错误只保存固定原因码，例如 `header-backfill-failed`、`history-backfill-failed`、`sync-failed`；未知来源记为 `unclassified`，不记录错误文本、邮件、路径或凭证。

根因证据与决策见 [同步重置 ADR](adr/sync-reset-verification.md)。

## 同步健康检查

桌面在 Settings → Accounts 选择账户，点击 Check sync health，再用 Copy redacted report 导出报告。CLI 构建后运行：

```sh
node packages/cli/dist/cli.js health --json
OPENMAIL_READ_ONLY=1 node packages/cli/dist/cli.js health --account 'gmail:me@example.com' --json
```

省略 `--account` 检查全部账户。`mailbox.sync.syncHealth` 请求 Gmail 标签计数、Graph 文件夹计数或 IMAP STATUS；摘要计数低于本地时，只读查询消息集合复核，不读取消息文本、不修改服务商。约十秒网络预算、最多四个并发请求；失败的文件夹保留本地数并标为服务商不可用。smoke 同样输出该报告，运行方式见[测试](testing.md#desktop-production-build-smoke-test)。

| 报告项                           | 含义                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`、`server`                | 总数、未读数及可用的会话数；判断比较邮件总数和未读数，不比较会话数                                                                                                          |
| `bodyCacheWindowDays`            | 消息文本保留天数；`null` 表示全部保留，邮件头不会因此过期                                                                                                                   |
| `headerWindow`                   | 历史回填未完成时的初始邮件头范围：Gmail 90 天／最多 2000 封，IMAP 90 天／每文件夹最多 1000 封；带 `__windowDays="90"` 游标的 Outlook 为 90 天／最多 5000 封，旧游标不标窗口 |
| `cursorAgeMs`                    | 有游标时距上次同步的毫秒数；`null` 表示无可用游标年龄                                                                                                                       |
| `pendingOps`                     | 待推送操作数；本地离线改动可能造成计数差异                                                                                                                                  |
| `accountDomainHash`、`checkedAt` | 账户邮箱域名的 SHA-256 与检查时间；散列不代表匿名化                                                                                                                         |

Gmail／Outlook 的 Drafts 本地总数和会话数还包含符合上述[孤立远端草稿规则](#过期缓存扫描)的行，按远端消息 ID 去重；未读数仍只来自 messages。

Outlook Drafts 本地 40、服务端约 22 的差异尚无真实服务器身份样本，不能仅凭计数确认 Graph 漏报 `@removed`。从现有代码可以确认：本地消息只在明确删除事件或存在性验证后移除；离线期间在其他设备删除的草稿，若增量未报告删除，就会暂留缓存。90 天窗口或 410 重列举不覆盖全部历史草稿；完整同步后的过期扫描每小时、每轮最多 500 项，失败、限流和未验证项继续保留。因此“曾删除但还未验证”的消息，以及未镜像到 messages 的远端草稿，都可能让 local.total 超过服务器数。现有计数复核和逐项清理已有回归；本次没有证据修改 delta 行为。

健康报告在 Outlook Drafts 复核后仍多出时附 `diagnostic.code = "OUTLOOK_DRAFT_COUNT_EXCESS"`。`cachedTotal` 与 `unmirroredDraftTotal` 拆开两种计数来源；按 providerId 取最多 50 个候选，使用剩余十秒预算内最多一秒的只读位置／存在性验证，报告 `sampled`、`gone`、`outsideDrafts`、`presentInDrafts`、`unverified`。这些是抽样数，不能当成全夹数量。gone 证明当前身份已不存在，outsideDrafts 证明缓存归属陈旧；两者都不能单独证明 delta 漏报，下一次排查应结合游标年龄、上次同步时间及增量事件。超时或缺失响应计入 unverified，不作为删除证据。

诊断只输出固定码和数字，脱敏导出保留它，不读取消息文本、不改缓存、草稿或操作队列。正常完整同步的过期扫描直接验证自己的候选，不再重复做诊断抽样。回归见 [sync-health.test.ts](../packages/core/src/sync/sync-health.test.ts)。

判断结果按以下规则解释：

- 一致：邮件总数和未读数相等，不证明消息身份、标记或内容一致。
- 本地较少，同步窗口：总数少于服务商，且仍有初始邮件头范围；可能只是等待回填。IMAP 若本地数低于游标已追踪 UID 数，仍判为缺失。
- 本地较少，缺失：无上述窗口解释，或总数相等但未读数较少。
- 本地较多，陈旧：总数或未读数超过服务商；完整同步可触发上述过期缓存扫描；健康检查本身不清理，计数差不能证明某个 ID 已删除。
- 服务商不可用：请求失败或超时；不说明本地缓存损坏。

CLI、桌面复制及 smoke 导出通过 `redactSyncHealth` 将自定义标签／文件夹改为 `folder:N`，只保留计数、固定状态、时间和域名散列，不含主题、消息文本或 token。实现见 [sync-health.ts](../packages/core/src/sync/sync-health.ts)、[store-sync-health.ts](../packages/core/src/store/store-sync-health.ts)、[CLI](../packages/cli/src/cli.ts)和[桌面界面](../apps/desktop/src/renderer/src/features/settings/sections/SyncHealth.tsx)，回归见 [sync-health.test.ts](../packages/core/src/sync/sync-health.test.ts)。

## 断网与同步恢复

Gmail／Outlook 的后台拉取、计数、验证及维护共用每账户断网退避；只把明确 status 0 的非延期失败计入。传输失败从五秒开始指数等待，最长五分钟；等待期间不重新刷新 token 或发起后台请求，延期不写 provider-failure。发送、打开正文和下载附件绕过断网等待，成功会重置失败次数；手动 Sync RPC 先调用 portable `mailbox.sync.resetConnectivity`。发送提交失败仍按既有发送确认流程查询 Sent，提交和确认不会被断网等待拦截。系统唤醒、renderer online 和手机 AppState active 事件清除断网和 Inbox 轮询等待，立即恢复同步。手机未安装 NetInfo，使用既有 expo-network 的 addNetworkStateListener 处理前台网络恢复；服务端 Retry-After 独立保存，不能被这些事件清除。

Gmail／Graph 请求在 60 秒内收不到响应头，或响应体 60 秒没有新数据时，按 status 0 的传输失败处理；请求体每 20 KiB 另给响应头 1 秒上传时间。发送随后走 Sent 精确 Message-ID 确认。token 刷新限时 60 秒，超时不标记重新登录。

resetConnectivity 让因断网失败的排队操作立即到期，429／5xx 的退避不变，并让等待中的 IDLE 立即重连。迁移 42 用 retry_offline 记录断网失败。桌面主进程每五秒读取 `net.isOnline()`，恢复在线时调用 resetConnectivity 和 sync。回归见 [network-failures.test.ts](../packages/core/src/providers/network-failures.test.ts)。

同步中的 provider 缺陷返回固定失败文案并允许后续账户和下一轮自动同步继续；runSync 的维护异常也会释放共享等待和 running 状态。手动同步的中断传播并释放状态；自动循环静默处理纯中断并继续下一轮，关闭作用域时正常取消且不记录崩溃。崩溃诊断只保留 pull／verification／health／headers／maintenance 阶段及 defect／failure 分类，不记录 Cause 的内容。原有单条 sync-crashed 日志没有这些字段，无法据此还原那次具体异常。回归见 `uid-remap.test.ts`、`provider-connectivity.test.ts`、`outlook.test.ts`、`gmail.test.ts`。

Graph 搜索集合的 `$select` 不含 internetMessageHeaders，attachments 的 name／contentType／size／isInline 元数据经 `$expand` 一次取得；搜索不逐项 GET 附件或 MIME，服务商省略附件扩展或存在签名容器时，将正文标为待完整读取，打开阅读器后再补齐。未完成的搜索结果保留已缓存的附件清单，阅读器补全同时写入完整附件清单，避免空扩展或原始签名容器覆盖已解码的 PDF 等附件。标点词保留转义后的 KQL 引号。Graph 普通搜索词仅使用一层 `$search="词"`，短语及属性查询保留 KQL 转义，不混入 `$filter` 或 `$orderby`。搜索请求使用读取错误映射；桌面使用 Lingui 搜索专用文案并保留本地结果。实现依据 [Graph 搜索文档](https://learn.microsoft.com/en-us/graph/search-query-parameter)，回归覆盖 E64KZJ、短语转义和搜索拒绝。脱敏日志未包含 Graph 响应错误码或查询，普通词的双层引号及集合上的 internetMessageHeaders 选择已移除，附件扩展保留；不能仅凭原日志证明哪一项导致该次拒绝。搜索失败诊断记录 operation=search 和固定枚举的 Graph error.code，未知值记为 unknown；不记录响应 message 或 query。只读真实数据库备份中，Gmail CATEGORY_PERSONAL 有 22 条消息、21 个线程；Outlook Drafts 有 40 条消息、37 个线程，其中 38 条早于 90 天。两账户 drafts 表及 pending_ops 均为 0，没有孤立草稿、local-only 草稿或队列重复计数。真实服务商计数请求未成功，不能据此把这些缓存行排除，也不能认定差值来自本地 SQL；保留待服务商总数确认的结论。

## 重新登录的判定

只有确定的答复会让账户暂停并提示重新登录，并在 `accounts.reauth_reason`（迁移 44）和诊断 `reauth` 事件里记下原因：

| 触发                                                                           | 原因代码              |
| ------------------------------------------------------------------------------ | --------------------- |
| token 端点返回 400／401 `invalid_grant` 或 `interaction_required`              | `token_revoked`       |
| 内置 Google 客户端签发的 token 返回 `invalid_grant`，且签发时间至少在 6.5 天前 | `testing_mode_expiry` |
| token 端点返回 `consent_required`                                              | `scope_missing`       |
| `invalid_client`、`unauthorized_client`，或签发 token 的客户端已不在配置里     | `client_mismatch`     |
| 钥匙串里没有该账户的条目                                                       | `keychain_missing`    |
| TCP 和 TLS 已建立后 IMAP LOGIN 被拒，或 SMTP 535                               | `imap_auth_failed`    |
| API 401：清掉缓存的 access token，强制刷新一次后重试，仍是 401                 | `token_revoked`       |

其余都按可重试处理：断网和 DNS 失败、5xx、429、超时、强制刷新前的单次 401、token 端点的其他 4xx，以及 RFC 5530 的 `UNAVAILABLE`、`INUSE`、`LIMIT`、`SERVERBUG` 登录拒绝和 SMTP 454。发送的 401 同样先刷新再重试：401 表示服务端没有处理请求。

内置客户端的 Google 应用处于 Testing，所以只对它使用这条时间判断。自己的客户端发布状态未知，没有签发时间的账户也无法判断，两者都记为 `token_revoked`。

钥匙串读写失败（睡眠后锁定、`errSecInteractionNotAllowed`）在 Node adapter 里按 250 ms 起的指数退避重试三次；用户取消或拒绝提示（`errSecUserCanceled`，-128）时不重试。最终失败时返回 `reason: "keychain"` 的 ProviderError，不标记重新登录；同步错误显示为钥匙串已锁定。`@napi-rs/keyring` 只在条目不存在时返回 undefined，其他情况都 reject。

token 刷新按账户串行。Microsoft 轮换 refresh token：新 token 先写入钥匙串，写完才使用新的 access token。写入前重读钥匙串，条目已不存在说明账户在刷新期间被删除，此时不写入。写入失败时钥匙串保留旧 token（个人账户的旧 token 仍有效），新 token 留在内存里，下次刷新先重试写入再使用。刷新返回 `invalid_grant` 时重读一次钥匙串；CLI 或 MCP 已换成新 token 时用新 token 重试一次，没有变化才标记。

桌面后台在启动 1 分钟后检查一次，之后每 6 小时检查一次，本进程超过 6 天没有刷新的 OAuth 账户会刷新一次 token，停用、暂停同步和只读会话也执行；它不拉取邮件，也不写邮箱。停用的账户不同步，所以每次启动 app 会刷新一次，app 一直开着时每 6 天一次。Microsoft 个人账户的 refresh token 闲置 90 天过期，这个间隔让运行中的 app 不会碰到这条限制。实现见 [reauth.ts](../packages/core/src/providers/reauth.ts)、[provider-http.ts](../packages/core/src/providers/provider-http.ts)、[token-keepalive.ts](../packages/core/src/sync/token-keepalive.ts)，回归见 [reauth.test.ts](../packages/core/src/providers/reauth.test.ts)。
