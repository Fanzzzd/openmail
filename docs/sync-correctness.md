# 同步与发送结果

UIDNEXT 回退且 UIDVALIDITY 未变时，旧 UID 已不可信。core 先失效远端草稿引用，把旧队列操作改成带无效 provider ID 的 `reconcile`，并撤销旧撤销记录与待审批提议。UID 身份失效会隔离保留全部旧缓存，用 Message-ID 验证；重新发现的邮件使用新的本地世代 ID，不复用旧句柄。此情况不按旧 UID 自动重映射。阅读视图在消息查询返回不存在时清除旧内容。IMAP 全量同步和普通收件箱轮询先拉取、后推送；按账户与推送队列互斥，其他账户操作不等拉取结束。UIDVALIDITY 改变时仍按 Message-ID 重映射，每个旧行在一次拉取中最多使用一次。手机 OS 后台任务仅增量拉取，不推送队列。实现见 [store.ts](../packages/core/src/store.ts)、[mailbox-live.ts](../packages/core/src/mailbox-live.ts)、[Node IMAP](../packages/core/src/platform/node/imap.ts)和[手机 IMAP](../packages/core/src/platform/react-native/imap.ts)。

文件夹失效后，尚未同步的本地改动会被丢弃，包括标签、已读、星标、稍后提醒和排队的远端草稿删除；相关操作只保留无效 ID 的清理记录，孤立提醒行会删除。推送在 SELECT 后核对保存的 UIDVALIDITY 和 UIDNEXT 下界；发现回退便返回永久错误，等待重新同步。

## IMAP 复制、移动与草稿

两端移动统一先 COPY、确认目标身份，再删除源副本。UIDPLUS 可定向清除源 UID；否则只加 `\Deleted`，不执行全局 EXPUNGE。两端同步、历史拉取与服务端搜索把 `\Deleted` 邮件视为不存在，避免恢复源文件夹副本。没有 UIDPLUS 时，服务器原件待其他客户端或服务器清除；永久删除仍要求 UIDPLUS。其他客户端撤销 `\Deleted` 后，旧 UID 要到重置游标后的完整窗口重扫才会重新出现。无 CONDSTORE 时，已有 UID 的标记最多每十分钟完整扫描一次。

COPY 前按排队操作、源 provider ID 和目标文件夹持久记录 issued 进度，成功回复后记录 accepted。首次操作正常复制，即使目标已有相同 Message-ID；重试才按进度查询目标，查到后只重做源副本删除。明确拒绝会清除对应进度；丢失回复时保留。源、目标均不存在且没有进度时返回 PermanentError，终止操作并 reconcile；有进度但结果未确认时继续等待。批量操作逐封记录，不能把一封的进度当作另一封的进度。

COPYUID 缺失时按 Message-ID 查目标 UID。已有 Message-ID 但 UID 未确认时保留源副本和队列；没有 Message-ID 且已确认 COPY 成功时完成源删除，排队 reconcile，并暂停本轮对旧 ID 的后续操作，由下一次拉取恢复缓存。重试前核对源邮件身份；比较时去掉尖括号和空白。手机特殊文件夹同时匹配路径末级名称，例如 `INBOX.Sent`；CREATE 的 `NO [ALREADYEXISTS]` 视为已存在。

Node IMAP 标记、复制和删除返回 false 时按 ProviderError 重试；PERMANENTFLAGS 禁止所需标记时永久失败。草稿 APPEND 前记录 Message-ID，重试先查已追加副本，避免重复追加。退避期间的编辑或手动重试保留这份身份和进度；发现内容已变则替换恢复的副本，最终只保留最新的可见副本。恢复的 UID 与旧引用相同时不删除该副本。丢弃草稿或保留本地副本时，排队按已记录的 Message-ID 清理未确认副本；切换账户时在原账户清理，不把旧身份用于新账户。新草稿 UID 未知时保留旧副本并失败；新关联已确定而旧副本清理失败时，排队 deleteDraft 重试清理。

实现见 [Node IMAP](../packages/core/src/platform/node/imap.ts)、[手机 IMAP](../packages/core/src/platform/react-native/imap.ts)与 [Store](../packages/core/src/store.ts)。回归入口见[测试](testing.md#出站操作与发送回归)。

## 出站操作队列

`pending_ops` 在失败后保存 retry_at，首次等待五秒，随后指数退避，最长一小时；刷新跳过尚未到期的操作，也不越过同一邮件的前置失败操作。断网、传输失败、429／deferred 和 5xx 不按重试次数丢弃。PermanentError 立即终止；普通操作再次推送失败且排队满七天时过期。reconcile 在账户不可达时一直保留。AuthError 暂停账户、标记重新登录并释放认领，不增加失败次数；只读会话不推送队列。

认领有效期两分钟，长推送每三十秒续租。每次认领有独立 token，结算及写入远端草稿关联时核对 token。续租或本地重映射失败只处理当前操作，无关操作及拉取继续；旧进程不能结算新进程认领的操作。迟到上传产生的独立草稿副本会清理，清理失败排队删除；当前草稿已引用的副本保留。

迁移 36 增加重试时间、认领 token、Message-ID、复制进度和草稿 APPEND 身份；既有排队操作从缓存补全 Message-ID。推送中终止的非 reconcile 操作和发送警告进入 failed_ops，桌面与手机按类别显示计数、操作、主题、发件人及原因，直到用户关闭提示。Graph 写入的 400、404、409、413、415、422 和 `403 ErrorAccessDenied` 为永久错误，界面显示简短原因，不显示 Graph JSON。

实现见 [mailbox-live.ts](../packages/core/src/mailbox-live.ts)、[store.ts](../packages/core/src/store.ts)、[db.ts](../packages/core/src/db.ts)和 [Outlook](../packages/core/src/outlook.ts)。

## 发送结果

每次 HTTP 请求的重试等待累计不超过 60 秒。Outlook 的发送、回复草稿准备与发送确认使用独立请求许可，不排在限流的拉取后面。IMAP 操作中断时关闭连接并从推送池移除；手机端同一连接的命令串行执行。

Gmail 和 Graph 的发送 POST 不自动重试。Message-ID 使用随机本地部分和发件人域名，不发送自定义追踪头。连接中断或服务端返回 5xx 后，core 在约 30 秒内以递增间隔查询“已发送”。查到副本才报告成功；仍无法确定时返回 `SendUncertain`，保留草稿，并在本地持久保存重发保护。再次发送同一草稿必须由 app 中的用户确认已检查“已发送”。此保护在重启后继续生效。

Gmail 官方文档规定提交 RFC 2822 MIME，并支持 `rfc822msgid` 搜索，但没有承诺保留客户端设置的 Message-ID。core 先查询完整 ID；没有结果时，搜索提交前一分钟至提交后两分钟的 Sent 候选，读取 Message-ID metadata 并核对随机本地部分。不依赖未文档化的部分 ID 搜索。若服务端连本地部分也重写，无法确认发送，继续保留重发保护。自动测试覆盖 ID 保留、域名改写、延迟副本和未找到副本；没有用真实账户发送探测邮件。参见 [发送邮件](https://developers.google.com/workspace/gmail/api/guides/sending)、[消息列表查询](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 搜索条件](https://support.google.com/mail/answer/7190)。

Graph 用 `internetMessageId` 查询 Sent。回复草稿创建结果不确定时，同样按提交时设置的 ID 查询 Drafts，并清理找到的孤立草稿；草稿准备失败也会清理，发送成功后不会删除 Sent 副本。参见 [创建回复草稿](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)和 [更新草稿 Message-ID](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)。

IMAP SMTP 在 DATA 终止符已发出后丢失回复时，按 Message-ID 查询 Sent；未确认则返回 SendUncertain，保留草稿和重发保护。DATA 前的连接拒绝、超时或 greeting 失败属于明确失败；收到 5xx 拒绝也属明确失败，认证错误仍提示重新登录。SMTP 接受后保存 Sent 副本失败会重连重试 APPEND 一次；再次失败时显示副本缺失提示，不重新发送邮件。

Node SMTP 部分拒收会列出拒收地址，保留原草稿并启用重发保护。提示中的“仅向拒收收件人重发”创建新草稿，只保留拒收的 To／Cc／Bcc，保留消息文本及附件，不自动发送，也不修改原草稿。

发送确认实现见 [provider-send.ts](../packages/core/src/provider-send.ts)、[Node IMAP](../packages/core/src/platform/node/imap.ts)和[手机 IMAP](../packages/core/src/platform/react-native/imap.ts)；失败提示经 Mailbox 的 listFailedOps、acknowledgeFailedOps 与 prepareRejectedResend 提供。

## 重置删除保护

重置的 keep 集合只覆盖本轮列出的范围。Outlook 初始同步和 410 重启按最近 90 天的 `receivedDateTime` 过滤并倒序分页。delta URL 不带 `$top`；初始请求、nextLink、deltaLink 每次都发送 `Prefer: IdType="ImmutableId", odata.maxpagesize=50`，普通列表端点仍可用 `$top`。删除候选使用同一起点，窗外消息保留。过滤 delta 最多返回 5,000 条，不能据此证明缺失邮件已删除。窗口内所有缺失项都要验证；缺少最终 deltaLink 时保留旧游标，下一轮重新列举。[Graph delta 文档](https://learn.microsoft.com/en-us/graph/delta-query-messages)说明了过滤、排序、条数上限和续页链接。

Gmail history-404 恢复列出最近 90 天，恢复分页不受初次同步的 2,000 条限制，Reset 仅覆盖相同日期范围。IMAP UIDVALIDITY 重建只检查 SINCE 日起的窗口；每个文件夹最多取最新 1,000 条，因此窗口内缺失项也须验证。已有 UID 的标记扫描仅清理明确扫描过的 ID。文件夹消失和 UID 复用分别校验原文件夹身份与 Message-ID，不用新 UID 的存在证明旧消息仍在。

slice 62 移除了删除数量阈值。Reset、DeleteLabel 和 RebuildFolder 中所有未列入 keep 的删除候选都先入持久验证队列，即使只缺一封也须验证；不因列表标记完整或为空直接删除。持久队列的预算、续验与扫描规则见[过期缓存扫描](#过期缓存扫描)。Graph 每批最多 20 个只读请求，使用四个拉取许可，遵守内部请求的 Retry-After；发送许可保持独立。Gmail 用 minimal 批量读取，IMAP 用 UNDELETED UID SEARCH 和 Message-ID 搜索。确认消失才删除；找到同文件夹副本则保留，移到其他文件夹则更新归属。`sync-reset` 日志只记录账户、文件夹的哈希和计数。

保护已随 slice 56 合入。验证队列使用既有 prefs 持久化，无新增迁移；本地队列未验证完时继续保留缓存。只读会话允许这些存在性探测，包括只含 GET 子请求的 Graph batch。实现见 [sync-reset.ts](../packages/core/src/sync-reset.ts)、[store-sync-reset.ts](../packages/core/src/store-sync-reset.ts)、[Outlook](../packages/core/src/outlook.ts)、[Gmail](../packages/core/src/gmail.ts)和 [read-only.ts](../packages/core/src/read-only.ts)。回归见 [sync-reset.test.ts](../packages/core/src/sync-reset.test.ts)和 [sync-reset-imap.test.ts](../packages/core/src/sync-reset-imap.test.ts)。

Node IMAP adapter 将 ImapFlow SEARCH 返回的 false／undefined 视为 ProviderError，不转成空 UID 集合。首次拉取、增量、标记扫描、历史回填、服务端搜索和存在性验证共用此规则，搜索失败不能证明邮件消失。文件夹遗漏先核对 STATUS；只有明确 NotFound 且再次 LIST 仍缺失才确认删除，失败或隐藏文件夹保留旧状态。Outlook 同样先直接 GET 遗漏的文件夹，仅明确 404 才进入删除验证，其他结果保留旧游标。实现见 [Node IMAP](../packages/core/src/platform/node/imap.ts)、[Outlook](../packages/core/src/outlook.ts)和 [store.ts](../packages/core/src/store.ts)，回归见 [imap.test.ts](../packages/core/src/imap.test.ts)及 [sync-reset-imap.test.ts](../packages/core/src/sync-reset-imap.test.ts)。

## 过期缓存扫描

完整同步后，stale sweep 每账户每小时最多运行一次。扫描时间和分页位置保存在 prefs，重启后沿用。只扫描服务端计数可用且 `local.total > server.total` 的文件夹；仅未读数过多不触发扫描，因为 Graph 与 IMAP 的位置验证不读取当前标记。

扫描每账户每轮最多验证 500 个 ID，使用独立预算。重置和 Outlook 冲突验证仍共用每轮同步、所有账户合计 500 个 ID 的持久队列预算。扫描跳过队列中和本轮已验证的 ID，避免消耗重置预算或重复请求。失败和未验证行保留，扫描位置轮转，下一次满足小时频率时续验。网络请求沿用服务商的锁和重试规则；批次重试耗尽后停止剩余批次，不绕过 Retry-After。

计数差只提供候选范围，清理复用上述服务器验证路径。验证结果先叠加待推送操作，保留本地未同步改动。Gmail drafts.list 只读取最多 500 条的一页，列出的 ID 可证明存在，未列出的 ID 仍须逐项验证。

Drafts 孤立草稿只统计已有 `remote_message_id`、`local_only=0`、`sync_error IS NULL` 且没有对应消息行的草稿，按远端消息 ID 去重；扫描候选使用相同规则。本地未上传、local-only 和同步失败的草稿不计入孤立远端行。404 清理继续保护有待处理 saveDraft 的草稿，不删除尚未上传的编辑内容。

Outlook 同轮出现同 ID 的更新和移除时，只要更新文件夹与移除文件夹重叠，就先把 ID 保存到持久验证队列，再保存游标。拉取不内联验证；随后按共享预算核对当前位置。限流、权限错误和没有明确答案的 ID 留在队列，后续同步续验。这覆盖从后处理文件夹移动到 Inbox、旧文件夹更新覆盖了新位置的情况。

实现见 [sync-reset.ts](../packages/core/src/sync-reset.ts)、[store-sync-reset.ts](../packages/core/src/store-sync-reset.ts)、[Outlook](../packages/core/src/outlook.ts)和 [store-sync-health.ts](../packages/core/src/store-sync-health.ts)，回归见 [sync-stale.test.ts](../packages/core/src/sync-stale.test.ts)、[sync-reset.test.ts](../packages/core/src/sync-reset.test.ts)及 [outlook.test.ts](../packages/core/src/outlook.test.ts)。

## slice 56 根因证据

协调器在只读真实数据副本上运行 sync-health，得到以下结果：

| Outlook 文件夹 |              服务端消息 |                  本地消息 |
| -------------- | ----------------------: | ------------------------: |
| Inbox          | 28,666，其中未读 26,042 | 重启前 1,199，重列举约 91 |
| Sent           |                      98 |                        65 |
| Archive        |                     103 |                        52 |

410 重启后的缺失不能解释为服务端 Inbox 缩小。已确认的客户端错误是：把未证明完整的 delta 列举当作整个文件夹的 keep 集合，清理约 1,100 条本地消息；源码还允许在没有 nextLink 或 deltaLink 时结束，并在缺少 conversationId 的单项 GET 返回 404 后漏记 listed ID。旧 Outlook 循环没有 90 天或 2,000 条截断，也没有日期过滤。当前实现明确限定日期范围，将每个列出的 ID 立即加入 keep，失败的完整读取稍后补取，并验证窗口内缺失项。

协调器随后在只读真实数据副本上验证 `532b888`：Outlook 保留 1,479 条，没有大规模删除。新诊断显示，410 重启后 Inbox 的 listing 阶段 `listed:50, kept:50`，reset 阶段全局 keep 为 53，文件夹范围内本地有 512 条。50 与旧初始 delta URL 的 `$top=50` 一致；这次观测中 Graph 把 `$top` 用作本轮上限，在 50 条后直接返回 deltaLink，没有 nextLink，适配器因而停止枚举。

根因修复将页大小移到 `odata.maxpagesize` 请求头，并从 delta 请求 URL 删除 `$top`，包括旧游标中的显式参数。回归假 Graph 在有 `$top` 时复现“50 条后结束”，改用请求头后按 50、50、23 分页交付全部 123 条；初始同步、410 重启、续页和下一轮增量都检查请求头与 ImmutableId 设置。窗口范围、5,000 条过滤上限的保护、逐项验证和持久续验继续生效。已有 28,666 条服务端计数、1,199 条窗内缓存与 91 条列举的回归仍通过 `syncHealth` 检查本地保留，并覆盖窗外邮件、UID 复用、移动和失败。

重试与发送确认实现见 [provider-retry.ts](../packages/core/src/provider-retry.ts)、[Gmail](../packages/core/src/gmail.ts)、[Outlook](../packages/core/src/outlook.ts)和 [mailbox-live.ts](../packages/core/src/mailbox-live.ts)。UID 重置与发送回归见 [mailbox-syncfix.test.ts](../packages/core/src/mailbox-syncfix.test.ts)及 [store.test.ts](../packages/core/src/store.test.ts)。

## 同步健康检查

桌面在 Settings → Accounts 选择账户，点击 Check sync health，再用 Copy redacted report 导出报告。CLI 构建后运行：

```sh
node packages/cli/dist/cli.js health --json
OPENMAIL_READ_ONLY=1 node packages/cli/dist/cli.js health --account 'gmail:me@example.com' --json
```

省略 `--account` 检查全部账户。`Mailbox.syncHealth` 只请求 Gmail 标签计数、Graph 文件夹计数或 IMAP STATUS，不拉取邮件、不修复数据、不修改服务商。约十秒网络预算、最多四个并发请求；失败的文件夹保留本地数并标为服务商不可用。smoke 同样输出该报告，运行方式见[测试](testing.md#桌面生产构建-smoke)。

| 报告项                           | 含义                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`、`server`                | 总数、未读数及可用的会话数；判断比较邮件总数和未读数，不比较会话数                                                                                                          |
| `bodyCacheWindowDays`            | 消息文本保留天数；`null` 表示全部保留，邮件头不会因此过期                                                                                                                   |
| `headerWindow`                   | 历史回填未完成时的初始邮件头范围：Gmail 90 天／最多 2000 封，IMAP 90 天／每文件夹最多 1000 封；带 `__windowDays="90"` 游标的 Outlook 为 90 天／最多 5000 封，旧游标不标窗口 |
| `cursorAgeMs`                    | 有游标时距上次同步的毫秒数；`null` 表示无可用游标年龄                                                                                                                       |
| `pendingOps`                     | 待推送操作数；本地离线改动可能造成计数差异                                                                                                                                  |
| `accountDomainHash`、`checkedAt` | 账户邮箱域名的 SHA-256 与检查时间；散列不代表匿名化                                                                                                                         |

Gmail／Outlook 的 Drafts 本地总数和会话数还包含符合上述[孤立远端草稿规则](#过期缓存扫描)的行，按远端消息 ID 去重；未读数仍只来自 messages。

判断结果按以下规则解释：

- 一致：邮件总数和未读数相等，不证明消息身份、标记或内容一致。
- 本地较少，同步窗口：总数少于服务商，且仍有初始邮件头范围；可能只是等待回填。IMAP 若本地数低于游标已追踪 UID 数，仍判为缺失。
- 本地较少，缺失：无上述窗口解释，或总数相等但未读数较少。
- 本地较多，陈旧：总数或未读数超过服务商；完整同步可触发上述过期缓存扫描；健康检查本身不清理，计数差不能证明某个 ID 已删除。
- 服务商不可用：请求失败或超时；不说明本地缓存损坏。

CLI、桌面复制及 smoke 导出通过 `redactSyncHealth` 将自定义标签／文件夹改为 `folder:N`，只保留计数、固定状态、时间和域名散列，不含主题、消息文本或 token。实现见 [sync-health.ts](../packages/core/src/sync-health.ts)、[store-sync-health.ts](../packages/core/src/store-sync-health.ts)、[CLI](../packages/cli/src/cli.ts)和[桌面界面](../apps/desktop/src/renderer/src/components/SyncHealth.tsx)，回归见 [sync-health.test.ts](../packages/core/src/sync-health.test.ts)。
