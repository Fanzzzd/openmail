# O30 服务器规则覆盖

按 2026-10-06 的官方 API 文档核对。状态指 openmail 编辑器：**支持**可编辑，**只读**保留服务器定义并提示网页编辑，**缺失**未接入。没有转发地址验证流程，因此不新增转发或重定向动作。

## Gmail

来源：[Filter、Criteria、Action](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters)、[Filter 动作指南](https://developers.google.com/workspace/gmail/api/guides/filter_settings)、[系统标签可写范围](https://developers.google.com/workspace/gmail/api/guides/labels)。

| 条件字段         | 状态 | 编辑与预览                                       |
| ---------------- | ---- | ------------------------------------------------ |
| `from`           | 支持 | 发件人名称或地址；服务器预览                     |
| `to`             | 支持 | 收件人名称或地址，包含 To、CC、BCC；服务器预览   |
| `subject`        | 支持 | 主题包含；服务器预览                             |
| `query`          | 支持 | 搜索查询、包含词；服务器预览                     |
| `negatedQuery`   | 支持 | 排除词／查询；服务器预览                         |
| `hasAttachment`  | 支持 | 有附件；服务器预览                               |
| `excludeChats`   | 支持 | 排除聊天，预览查询使用 `-is:chat`                |
| `size`           | 支持 | 完整消息大小，单位字节；服务器预览               |
| `sizeComparison` | 支持 | `larger`、`smaller`；已有 `unspecified` 保持只读 |

| 动作字段         | 状态 | 编辑方式                                                                                                                                                                                       |
| ---------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addLabelIds`    | 支持 | 加星、删除、标签、重要性、分类及更多标签动作；标签集合保留多值。添加 `INBOX`／`UNREAD`／`SPAM`／`SENT`／`DRAFT` 的原生规则只读。前三项未在 Filter 指南中明确列为添加动作，编辑器不提供这些选项 |
| `removeLabelIds` | 支持 | 归档、标为已读、取消重要及移除用户／系统标签                                                                                                                                                   |
| `forward`        | 只读 | 保留已有规则；在网页编辑                                                                                                                                                                       |

未知条件／动作字段保持只读。Gmail 没有更新过滤器接口，修改仍使用删除后重建及已有恢复机制。恢复原始定义保留未知字段。标签增删互相冲突时拒绝保存。

## Outlook Graph v1.0

来源：[messageRulePredicates](https://learn.microsoft.com/en-us/graph/api/resources/messagerulepredicates?view=graph-rest-1.0)、[messageRuleActions](https://learn.microsoft.com/en-us/graph/api/resources/messageruleactions?view=graph-rest-1.0)、[sizeRange](https://learn.microsoft.com/en-us/graph/api/resources/sizerange?view=graph-rest-1.0)。以下每个谓词状态同时适用于 `conditions` 和 `exceptions`。

| 条件／例外字段           | 状态 | 本地预览                                                                                                     |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------ |
| `bodyContains`           | 支持 | 消息文本包含完整字符串；消息文本未缓存时不可判断                                                             |
| `bodyOrSubjectContains`  | 支持 | 消息文本或主题包含；主题未命中且消息文本未缓存时不可判断                                                     |
| `categories`             | 只读 | 网页编辑                                                                                                     |
| `fromAddresses`          | 只读 | 保留精确地址语义，网页编辑                                                                                   |
| `hasAttachments`         | 支持 | Graph 缓存附件已在 provider 边界剔除 `isInline`；附件缓存为空且不完整时不可判断；显式 `false` 的原生谓词只读 |
| `headerContains`         | 支持 | 不可判断，缓存邮件头可能只有部分字段                                                                         |
| `importance`             | 支持 | `low`、`normal`、`high`；缓存不能区分全部等级，预览不可判断                                                  |
| `isApprovalRequest`      | 只读 | 网页编辑                                                                                                     |
| `isAutomaticForward`     | 只读 | 网页编辑                                                                                                     |
| `isAutomaticReply`       | 支持 | 缺少消息类型元数据，预览不可判断                                                                             |
| `isEncrypted`            | 只读 | 网页编辑                                                                                                     |
| `isMeetingRequest`       | 只读 | 网页编辑                                                                                                     |
| `isMeetingResponse`      | 只读 | 网页编辑                                                                                                     |
| `isNonDeliveryReport`    | 只读 | 网页编辑                                                                                                     |
| `isPermissionControlled` | 只读 | 网页编辑                                                                                                     |
| `isReadReceipt`          | 只读 | 网页编辑                                                                                                     |
| `isSigned`               | 只读 | 网页编辑                                                                                                     |
| `isVoicemail`            | 只读 | 网页编辑                                                                                                     |
| `messageActionFlag`      | 支持 | 全部 11 个值；缺少原生操作标记，预览不可判断                                                                 |
| `notSentToMe`            | 支持 | BCC 不完整，预览不可判断                                                                                     |
| `recipientContains`      | 支持 | To 或 CC 中的名称／地址包含；不把 BCC 计入                                                                   |
| `senderContains`         | 支持 | From 名称／地址包含                                                                                          |
| `sensitivity`            | 支持 | `normal`、`personal`、`private`、`confidential`；缺少元数据，预览不可判断                                    |
| `sentCcMe`               | 支持 | 账户身份或缓存的 send-as 别名位于 CC；身份集未知时不可判断                                                   |
| `sentOnlyToMe`           | 支持 | BCC 不完整，预览不可判断                                                                                     |
| `sentToAddresses`        | 只读 | 保留精确地址语义，网页编辑                                                                                   |
| `sentToMe`               | 支持 | 账户身份或缓存的 send-as 别名位于 To；身份集未知时不可判断                                                   |
| `sentToOrCcMe`           | 支持 | 账户身份或缓存的 send-as 别名位于 To 或 CC；身份集未知时不可判断                                             |
| `subjectContains`        | 支持 | 主题包含完整字符串                                                                                           |
| `withinSizeRange`        | 支持 | 最小／最大范围均可编辑，单位 KiB；边界包含端点，缺少消息大小时不可判断                                       |

`messageActionFlag` 可编辑值：`any`、`call`、`doNotForward`、`followUp`、`fyi`、`forward`、`noResponseNecessary`、`read`、`reply`、`replyToAll`、`review`。这里的 `forward` 是匹配传入消息的操作标记，不执行转发。

| 动作字段                | 状态 | 编辑与应用范围                                                     |
| ----------------------- | ---- | ------------------------------------------------------------------ |
| `assignCategories`      | 支持 | 每行一个分类；允许多个分类，仅用于服务器上的新邮件                 |
| `copyToFolder`          | 支持 | 从账户文件夹列表选择，仅用于服务器上的新邮件                       |
| `delete`                | 支持 | 移至已删除邮件；可应用到预览中的已有邮件                           |
| `forwardAsAttachmentTo` | 只读 | 保留；网页编辑                                                     |
| `forwardTo`             | 只读 | 保留；网页编辑                                                     |
| `markAsRead`            | 支持 | 标为已读；可应用到预览中的已有邮件                                 |
| `markImportance`        | 支持 | 低／普通／高，仅用于服务器上的新邮件                               |
| `moveToFolder`          | 支持 | 归档或选择文件夹                                                   |
| `permanentDelete`       | 只读 | 保留；不提供永久删除规则编辑                                       |
| `redirectTo`            | 只读 | 保留；网页编辑                                                     |
| `stopProcessingRules`   | 支持 | 停止后续服务器规则，保留显式 `false`；启用后仅用于服务器上的新邮件 |

## 保留与预览规则

- Outlook 字符串集合只编辑单值。多值、未知字段、未知枚举值、未知大小范围成员以及 Graph 标记 `isReadOnly` 的规则保持只读。读取或尝试修改均不覆盖服务器定义；例外使用相同保护。
- 本地预览和确认共用判断器。文本按不区分大小写的完整字符串匹配，不解释搜索操作符。条件字段取 AND，例外字段取 OR。收件人匹配只使用各原生谓词指定的地址范围。
- 收件关系判断仅使用当前账户身份和该账户缓存的 send-as 地址，不借用其他账户的身份。没有该账户的身份缓存时，这些条件和例外均不可判断。
- 所有删除／移至垃圾箱的规则都显示删除警告并要求确认，包括 Outlook 及没有搜索查询的规则。
- 元数据不足时显示“预览不可用”，确认结果携带缺失字段，不显示猜测的命中数。这类规则可保存供服务器处理新邮件，禁止应用到已有邮件。
- Outlook 本地预览最多扫描 10,001 条缓存候选。确认使用服务器返回的最多 201 条候选，再以同一判断器筛选。结果最多显示／应用 200 条，截断时提示限制；它不是完整邮箱计数。`hasWords`／`notWords` 仍在候选集上判断；消息文本未缓存时不可判断，即使在线也不会伪造命中数。
- Outlook 分类、复制、三档重要性和停止后续规则没有对应的已有邮件操作，禁止在“应用到已有邮件”时静默忽略。

目前没有把 Outlook 的完整字符串包含无损转换为 provider 搜索。[Graph 消息搜索](https://learn.microsoft.com/en-us/graph/search-query-parameter#use-search-on-message-collections)使用 KQL，[KQL 文本查询](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/keyword-query-language-kql-syntax-reference#using-words-in-the-free-text-keyql-query)按词项和前缀匹配，不能直接替换任意子串匹配。这是保留候选搜索和 O30 partial 的原因。

Graph provider 的原生附件列表剔除行内附件；从 MIME 或 UU 消息文本解析出的额外附件不携带原生 `isInline` 元数据，这类缓存的附件预览仍可能与 Graph 不同。

实现见 `organization.ts`、`outlook-rules.ts`、两个 provider settings 模块、`mailbox-organization.ts`、`ServerSettings.tsx`。`server-rules.test.ts` 使用 fake HTTP 验证新增请求体、再次保存与清空、只读保留，以及缓存预览／确认一致性。测试不使用真实 provider API。
