# 发送结果不确定时

Gmail 和 Graph 的发送 POST 不自动重试。连接中断或服务端返回 5xx 后，core 在约 30 秒内以递增间隔查询“已发送”。查到副本才报告成功；仍无法确定时返回 `SendUncertain`，保留草稿，并在本地持久保存重发保护。再次发送同一草稿必须由 app 中的用户确认已检查“已发送”。此保护在重启后继续生效。

Gmail 官方文档规定提交 RFC 2822 MIME，并支持 `rfc822msgid` 搜索，但没有承诺保留客户端设置的 Message-ID。因此不依赖该承诺：先查自有 Message-ID，再搜索同一提交时段、主题的 Sent 候选，读取 metadata 并核对随机 `X-OpenMail-Id`。不使用未经文档保证的任意头搜索。参见 [发送邮件](https://developers.google.com/workspace/gmail/api/guides/sending)、[消息列表查询](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 搜索条件](https://support.google.com/mail/answer/7190)。自动测试覆盖 Message-ID 被重写的响应；没有用真实账户发送探测邮件。

Graph 用 `internetMessageId` 查询 Sent。回复草稿创建结果不确定时，同样按提交时设置的 ID 查询 Drafts，并清理找到的孤立草稿；草稿准备失败也会清理，发送成功后不会删除 Sent 副本。参见 [创建回复草稿](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)和 [更新草稿 Message-ID](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)。
