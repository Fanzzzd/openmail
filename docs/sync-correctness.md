# 同步与发送结果

UIDNEXT 回退且 UIDVALIDITY 未变时，旧 UID 已不可信。core 先清除该文件夹的缓存与远端草稿引用，把旧队列操作改成带无效 provider ID 的 `reconcile`，再重新拉取最近窗口。此情况不按 Message-ID 重映射。持久文件夹世代保证重新拉取的消息不会复用失效的本地 ID，旧撤销记录与待审批提议会失效，阅读视图在消息查询返回不存在时清除旧内容。IMAP 全量同步和后台轮询先拉取、后推送；按账户与推送队列互斥，其他账户操作不等拉取结束；UIDVALIDITY 改变时仍按 Message-ID 重映射，每个旧行在一次拉取中最多使用一次。

文件夹失效后，尚未同步的本地改动会被丢弃，包括标签、已读、星标、稍后提醒和排队的远端草稿删除；相关操作只保留无效 ID 的清理记录，孤立提醒行会删除。推送在 SELECT 后核对保存的 UIDVALIDITY 和 UIDNEXT 下界；发现回退便返回永久错误，等待重新同步。

缺少 MOVE 和 UIDPLUS 时，移动使用 COPY 加 `\Deleted`，不执行全局 EXPUNGE。两端同步、历史拉取与服务端搜索把 `\Deleted` 邮件视为不存在，避免恢复源文件夹副本。服务器仍保留已标记的原件，直到其他客户端或服务器清除。永久删除仍要求 UIDPLUS 定向清除。其他客户端撤销 `\Deleted` 后，已从本地删除的旧 UID 要到重置游标后的完整窗口重扫才会重新出现，普通增量拉取不会恢复它。无 CONDSTORE 时，已有 UID 的标记最多每 10 分钟完整扫描一次，因此删除与标记变化可能延迟约 10 分钟。

每次 HTTP 请求的重试等待累计不超过 60 秒。Outlook 的发送、回复草稿准备与发送确认使用独立请求许可，不排在限流的拉取后面。IMAP 操作中断时关闭连接并从推送池移除；手机端同一连接的命令串行执行。

Gmail 和 Graph 的发送 POST 不自动重试。Message-ID 使用随机本地部分和发件人域名，不发送自定义追踪头。连接中断或服务端返回 5xx 后，core 在约 30 秒内以递增间隔查询“已发送”。查到副本才报告成功；仍无法确定时返回 `SendUncertain`，保留草稿，并在本地持久保存重发保护。再次发送同一草稿必须由 app 中的用户确认已检查“已发送”。此保护在重启后继续生效。

Gmail 官方文档规定提交 RFC 2822 MIME，并支持 `rfc822msgid` 搜索，但没有承诺保留客户端设置的 Message-ID。core 先查询完整 ID；没有结果时，搜索提交前一分钟至提交后两分钟的 Sent 候选，读取 Message-ID metadata 并核对随机本地部分。不依赖未文档化的部分 ID 搜索。若服务端连本地部分也重写，无法确认发送，继续保留重发保护。自动测试覆盖 ID 保留、域名改写、延迟副本和未找到副本；没有用真实账户发送探测邮件。参见 [发送邮件](https://developers.google.com/workspace/gmail/api/guides/sending)、[消息列表查询](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 搜索条件](https://support.google.com/mail/answer/7190)。

Graph 用 `internetMessageId` 查询 Sent。回复草稿创建结果不确定时，同样按提交时设置的 ID 查询 Drafts，并清理找到的孤立草稿；草稿准备失败也会清理，发送成功后不会删除 Sent 副本。参见 [创建回复草稿](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)和 [更新草稿 Message-ID](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)。
