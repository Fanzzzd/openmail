# 同步与发送结果

UIDNEXT 回退且 UIDVALIDITY 未变时，旧 UID 已不可信。core 先失效远端草稿引用，把旧队列操作改成带无效 provider ID 的 `reconcile`，并撤销旧撤销记录与待审批提议。大规模失效会隔离保留旧缓存，用 Message-ID 验证；重新发现的邮件使用新的本地世代 ID，不复用旧句柄。此情况不按旧 UID 自动重映射。阅读视图在消息查询返回不存在时清除旧内容。IMAP 全量同步和后台轮询先拉取、后推送；按账户与推送队列互斥，其他账户操作不等拉取结束。UIDVALIDITY 改变时仍按 Message-ID 重映射，每个旧行在一次拉取中最多使用一次。

文件夹失效后，尚未同步的本地改动会被丢弃，包括标签、已读、星标、稍后提醒和排队的远端草稿删除；相关操作只保留无效 ID 的清理记录，孤立提醒行会删除。推送在 SELECT 后核对保存的 UIDVALIDITY 和 UIDNEXT 下界；发现回退便返回永久错误，等待重新同步。

缺少 MOVE 和 UIDPLUS 时，移动使用 COPY 加 `\Deleted`，不执行全局 EXPUNGE。两端同步、历史拉取与服务端搜索把 `\Deleted` 邮件视为不存在，避免恢复源文件夹副本。服务器仍保留已标记的原件，直到其他客户端或服务器清除。永久删除仍要求 UIDPLUS 定向清除。其他客户端撤销 `\Deleted` 后，已从本地删除的旧 UID 要到重置游标后的完整窗口重扫才会重新出现，普通增量拉取不会恢复它。无 CONDSTORE 时，已有 UID 的标记最多每 10 分钟完整扫描一次，因此删除与标记变化可能延迟约 10 分钟。

每次 HTTP 请求的重试等待累计不超过 60 秒。Outlook 的发送、回复草稿准备与发送确认使用独立请求许可，不排在限流的拉取后面。IMAP 操作中断时关闭连接并从推送池移除；手机端同一连接的命令串行执行。

Gmail 和 Graph 的发送 POST 不自动重试。Message-ID 使用随机本地部分和发件人域名，不发送自定义追踪头。连接中断或服务端返回 5xx 后，core 在约 30 秒内以递增间隔查询“已发送”。查到副本才报告成功；仍无法确定时返回 `SendUncertain`，保留草稿，并在本地持久保存重发保护。再次发送同一草稿必须由 app 中的用户确认已检查“已发送”。此保护在重启后继续生效。

Gmail 官方文档规定提交 RFC 2822 MIME，并支持 `rfc822msgid` 搜索，但没有承诺保留客户端设置的 Message-ID。core 先查询完整 ID；没有结果时，搜索提交前一分钟至提交后两分钟的 Sent 候选，读取 Message-ID metadata 并核对随机本地部分。不依赖未文档化的部分 ID 搜索。若服务端连本地部分也重写，无法确认发送，继续保留重发保护。自动测试覆盖 ID 保留、域名改写、延迟副本和未找到副本；没有用真实账户发送探测邮件。参见 [发送邮件](https://developers.google.com/workspace/gmail/api/guides/sending)、[消息列表查询](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 搜索条件](https://support.google.com/mail/answer/7190)。

Graph 用 `internetMessageId` 查询 Sent。回复草稿创建结果不确定时，同样按提交时设置的 ID 查询 Drafts，并清理找到的孤立草稿；草稿准备失败也会清理，发送成功后不会删除 Sent 副本。参见 [创建回复草稿](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)和 [更新草稿 Message-ID](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)。

# 重置删除保护

重置的 keep 集合只覆盖本轮列出的范围。Outlook 初始同步和 410 重启按最近 90 天的 `receivedDateTime` 过滤并倒序分页。delta URL 不带 `$top`；初始请求、nextLink、deltaLink 每次都发送 `Prefer: IdType="ImmutableId", odata.maxpagesize=50`，普通列表端点仍可用 `$top`。删除候选使用同一起点，窗外消息保留。过滤 delta 最多返回 5,000 条，不能据此证明缺失邮件已删除。窗口内所有缺失项都要验证；缺少最终 deltaLink 时保留旧游标，下一轮重新列举。[Graph delta 文档](https://learn.microsoft.com/en-us/graph/delta-query-messages)说明了过滤、排序、条数上限和续页链接。

Gmail history-404 恢复列出最近 90 天，恢复分页不受初次同步的 2,000 条限制，Reset 仅覆盖相同日期范围。IMAP UIDVALIDITY 重建只检查 SINCE 日起的窗口；每个文件夹最多取最新 1,000 条，因此窗口内缺失项也须验证。已有 UID 的标记扫描仅清理明确扫描过的 ID。文件夹消失和 UID 复用分别校验原文件夹身份与 Message-ID，不用新 UID 的存在证明旧消息仍在。

其他 keep 清理或窗口扫描若拟删除超过 `max(50, 范围内本地行数的 20%)`，先入持久验证队列。持久队列的预算、续验与扫描规则见[过期缓存扫描](#过期缓存扫描)。Graph 每批最多 20 个只读请求，使用四个拉取许可，遵守内部请求的 Retry-After；发送许可保持独立。Gmail 用 minimal 批量读取，IMAP 用 UNDELETED UID SEARCH 和 Message-ID 搜索。确认消失才删除；找到同文件夹副本则保留，移到其他文件夹则更新归属。`sync-reset` 日志只记录账户、文件夹的哈希和计数。

# 过期缓存扫描

完整同步后，stale sweep 每账户每小时最多运行一次。扫描时间和分页位置保存在 prefs，重启后沿用。只扫描服务端计数可用且 `local.total > server.total` 的文件夹；仅未读数过多不触发扫描，因为 Graph 与 IMAP 的位置验证不读取当前标记。

扫描每账户每轮最多验证 500 个 ID，使用独立预算。重置和 Outlook 冲突验证仍共用每轮同步、所有账户合计 500 个 ID 的持久队列预算。扫描跳过队列中和本轮已验证的 ID，避免消耗重置预算或重复请求。失败和未验证行保留，扫描位置轮转，下一次满足小时频率时续验。网络请求沿用服务商的锁和重试规则；批次重试耗尽后停止剩余批次，不绕过 Retry-After。

计数差只提供候选范围，清理复用上述服务器验证路径。验证结果先叠加待推送操作，保留本地未同步改动。Gmail drafts.list 只读取最多 500 条的一页，列出的 ID 可证明存在，未列出的 ID 仍须逐项验证。

Drafts 孤立草稿只统计已有 `remote_message_id`、`local_only=0`、`sync_error IS NULL` 且没有对应消息行的草稿，按远端消息 ID 去重；扫描候选使用相同规则。本地未上传、local-only 和同步失败的草稿不计入孤立远端行。404 清理继续保护有待处理 saveDraft 的草稿，不删除尚未上传的编辑内容。

Outlook 同轮出现同 ID 的更新和移除时，只要更新文件夹与移除文件夹重叠，就先把 ID 保存到持久验证队列，再保存游标。拉取不内联验证；随后按共享预算核对当前位置。限流、权限错误和没有明确答案的 ID 留在队列，后续同步续验。这覆盖从后处理文件夹移动到 Inbox、旧文件夹更新覆盖了新位置的情况。

# Slice 56 根因证据

协调器在只读真实数据副本上运行 sync-health，得到以下结果：

| Outlook 文件夹 |              服务端消息 |                  本地消息 |
| -------------- | ----------------------: | ------------------------: |
| Inbox          | 28,666，其中未读 26,042 | 重启前 1,199，重列举约 91 |
| Sent           |                      98 |                        65 |
| Archive        |                     103 |                        52 |

410 重启后的缺失不能解释为服务端 Inbox 缩小。已确认的客户端错误是：把未证明完整的 delta 列举当作整个文件夹的 keep 集合，清理约 1,100 条本地消息；源码还允许在没有 nextLink 或 deltaLink 时结束，并在缺少 conversationId 的单项 GET 返回 404 后漏记 listed ID。旧 Outlook 循环没有 90 天或 2,000 条截断，也没有日期过滤。当前实现明确限定日期范围，将每个列出的 ID 立即加入 keep，失败的完整读取稍后补取，并验证窗口内缺失项。

协调器随后在只读真实数据副本上验证 `532b888`：Outlook 保留 1,479 条，没有大规模删除。新诊断显示，410 重启后 Inbox 的 listing 阶段 `listed:50, kept:50`，reset 阶段全局 keep 为 53，文件夹范围内本地有 512 条。50 与旧初始 delta URL 的 `$top=50` 一致；这次观测中 Graph 把 `$top` 用作本轮上限，在 50 条后直接返回 deltaLink，没有 nextLink，适配器因而停止枚举。

根因修复将页大小移到 `odata.maxpagesize` 请求头，并从 delta 请求 URL 删除 `$top`，包括旧游标中的显式参数。回归假 Graph 在有 `$top` 时复现“50 条后结束”，改用请求头后按 50、50、23 分页交付全部 123 条；初始同步、410 重启、续页和下一轮增量都检查请求头与 ImmutableId 设置。窗口范围、5,000 条过滤上限的保护、逐项验证和持久续验继续生效。已有 28,666 条服务端计数、1,199 条窗内缓存与 91 条列举的回归仍通过 `syncHealth` 检查本地保留，并覆盖窗外邮件、UID 复用、移动和失败。
