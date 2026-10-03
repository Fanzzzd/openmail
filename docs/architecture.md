# 架构

core 负责邮件网络、数据库、策略和同步。桌面、CLI、MCP 与手机界面调用 Mailbox，平台能力通过 Effect 服务提供。术语见 [CONTEXT.md](../CONTEXT.md)，源码约束只在 [AGENTS.md](../AGENTS.md)维护。

## 当前模块

| 模块            | 入口与职责                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox         | `mailbox.ts` 定义 Effect 服务；`mailbox-live.ts` 组装同步、队列、策略和事件                                                                                                                         |
| Mailbox 子模块  | `mailbox-batch.ts`、`mailbox-folders.ts`、`mailbox-cache.ts`、`mailbox-features.ts`、`mailbox-organization.ts`、`mailbox-ai.ts` 分别实现批量、破坏性文件夹操作、缓存、日历／联系人、搜索／整理与 AI |
| Store           | `services.ts` 定义端口，`store.ts` 与 `store-*.ts` 实现查询；`db.ts` 保存追加迁移及数据库能力                                                                                                       |
| ProviderAdapter | `services.ts` 定义接口；`gmail.ts`、`outlook.ts` 和 `platform/node/imap.ts` 实现协议                                                                                                                |
| 模型与工具      | `model.ts` 提供 Model；`tools.ts` 提供 MailToolkit；`tool-pages.ts` 处理游标和预算                                                                                                                  |
| 本机索引        | `indexer.ts`、`semantic-indexer.ts` 与 media／semantic Store 处理派生文本及向量                                                                                                                     |
| Node 平台       | `platform/node/` 实现数据库、密钥、OAuth、IMAP/SMTP、MIME、文件、PDF 和推理 worker                                                                                                                  |
| 手机平台        | `platform/react-native/` 提供 SQL／OAuth／MIME／IMAP/SMTP adapters；Expo OS Layers 在 `apps/mobile/src/platform/`                                                                                   |

## Mailbox 接口

Mailbox 是 Effect `Context.Service`。`NodeMailbox(options)` 返回已组装的 Layer；手机应用为 `MailboxLive` 提供移动 Layers。调用方获取 Mailbox 后运行其 Effect 或消费其 Stream。

| 方法                                                               | 行为                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `threads(query)`、`threadCount(query)`                             | 查询会话或单封列表与计数，支持日期／ID 分页                 |
| `thread(id)`                                                       | 读取本地会话，不请求服务商、不补取冷正文                    |
| `readerThread(id)`                                                 | 桌面显式补取缺失消息文本，单封失败保留邮件头                |
| `thread(id, "model", tokenBudget)`、`threadForModel(id, maxChars)` | 生成有消息 ID 的纯文本模型上下文                            |
| `perform(command, actor)`                                          | 检查策略，返回 `applied`、`proposed` 或 `denied`            |
| `modifyWithUndo`、`undoBatch`、`undoHistory`                       | 批量／单封修改和持久撤销                                    |
| `saveDraft`、`openDraft`、`discardDraft`                           | 管理用户草稿；模型草稿使用 `perform` 的 draft 命令          |
| `sync(accountId?)`、`pollInbox`                                    | 完整同步和轻量收件箱轮询；CLI/MCP 不启动桌面轮询计时器      |
| `syncHealth(accountId)`                                            | 只读服务商计数与本地投影，返回同步健康报告                  |
| `optionalServices`、`reauth`、`setServiceEnabled`                  | 查询服务授权、走官方同意页及控制本机启停                    |
| `events`                                                           | `Changed`、同步状态／进度、新邮件、回填进度和更新设置事件流 |

其余账户、Profiles、设置、联系人、日历、缓存与 AI 方法以 `mailbox.ts` 为准。永久删除与清空文件夹走独立的确认接口，不放入模型工具的普通 MailOp。

### 策略与改动

`domain.ts` 定义 Command、Actor 和 Outcome，`policy.ts` 的 `decide` 根据入口与写权限判断。用户操作走执行路径；规则按权限直接执行或提议。MCP 和内置助手的写入须审批，代理发送不能直接执行。工具开关与审批细节只在[代理使用指南](agents.md#提议改动)维护。

普通修改在 core 展开会话，应用本地状态，记录 `pending_ops` 与 `audit_log`，再尝试推送服务商。可重试错误保留队列，ProviderError 累计五次后移除操作，永久错误立即移除；草稿保留同步错误供用户恢复。授权失效标记账户需重新登录并释放认领。同步落库时保留待推送操作的本地结果，避免拉取覆盖离线改动。

批量路径记录逐封逆向状态。`undo-journal.ts` 持久保存记录，重启后仍可查询；撤销前检查消息状态，防止覆盖后续操作。删除服务商规则的恢复记录另存，不混入邮件撤销。

### 只读会话

`OPENMAIL_READ_ONLY=1` 在 Layer 构建时读取。Node Providers 和 portable Mailbox 均包裹 [read-only.ts](../packages/core/src/read-only.ts) 的 adapter，只放行已列出的读取与连接方法；未知方法及 accessor 默认拒绝。邮件、文件夹、规则、自动回复、日历、草稿上传、发送和一键退订 POST 均受拦截。队列刷新跳过既有操作，延迟发送不执行，待处理项保留原状态。

本地偏好、草稿、已读状态和提议仍可保存。该开关不隔离数据库，也不阻止网络读取、标准 Secrets 读取或 token 刷新，不扩大 OAuth scopes。组装与队列入口见 [Node Layers](../packages/core/src/platform/node/layers.ts) 和 [mailbox-live.ts](../packages/core/src/mailbox-live.ts)，回归见 [read-only.test.ts](../packages/core/src/read-only.test.ts)。使用数据库副本的运行方式只在[测试](testing.md#桌面生产构建-smoke)维护。

### 可选服务

[optional-services.ts](../packages/core/src/optional-services.ts) 定义基础及分服务 scopes，`scopedAdapter` 在 provider 调用前检查授权和本机开关。联系人、日历和服务商设置互不替代，缺权限不暂停邮件同步。只有显式停用联系人会清除服务器联系人、分组和照片，本地往来地址仍保留。授权兼容规则见 [store-services.ts](../packages/core/src/store-services.ts)，启停见 [mailbox-services.ts](../packages/core/src/mailbox-services.ts)。配置和 scope 表只在 [Google](setup-google.md#可选服务) 与 [Microsoft](setup-microsoft.md#可选服务)维护。

### Provider 与 Store

`ProviderAdapter.pull` 返回 `Stream<Change>`，Mailbox 统一消费邮件、删除、标签与游标变更。适配器提供 push、send、草稿、附件、搜索、联系人与日历等方法。Gmail 和 Outlook 使用可移植 HTTP；IMAP/SMTP 分别由 [Node adapter](../packages/core/src/platform/node/imap.ts) 和[手机 adapter](../packages/core/src/platform/react-native/imap.ts)实现。

Store 使用 Effect `SqlClient`。Node Layer 提供 `node:sqlite` 与可选 sqlite-vec；手机 Layer 提供 op-sqlite 并报告向量能力不可用。两端运行同一 `MIGRATIONS`。消息经 `upsertMessage` 更新，保留 rowid 与外部内容 FTS 的对应。词索引、trigram、徽标及联系人投影用于查询，性能证据见[性能](performance.md)。

[db.ts](../packages/core/src/db.ts) 的迁移已到 35：31 保存邮件头与词位置视图，32 保存认证结果及安全退订目标，33 保存本机可选服务开关，34 增加消息文本字节数、运行总量和 LRU 索引；35 调整 provider ID 与列表日期覆盖索引，并增加 IMAP 路径、孤立远端草稿和消息文本字节数索引。前 34 条未改，下一可用迁移编号为 36。索引的读取收益、写入与空间成本只在[性能](performance.md#迁移-35写入与磁盘成本)维护。消息文本容量预算默认关闭，启用后每小时或额度变更时回收；保留期限、星标、草稿和发件箱优先，额度不保证覆盖受保护内容。它不限制整个数据库或所有附件占用，见 [store-cache.ts](../packages/core/src/store-cache.ts)。

slice 56 已合入同步重置删除保护。slice 62 将所有重置删除候选纳入持久验证队列，验证失败保留；实现见 [sync-reset.ts](../packages/core/src/sync-reset.ts)和 [store-sync-reset.ts](../packages/core/src/store-sync-reset.ts)。slice 60 增加独立预算的过期缓存扫描与持久 Outlook 冲突验证，仍不按计数差直接删除。删除范围、扫描预算、Outlook delta 页大小、UID 身份隔离、发送结果与同步健康报告只在[同步说明](sync-correctness.md)维护。

[graph-pagination.ts](../packages/core/src/graph-pagination.ts) 校验 Graph 列表续页链接：仅接受 `https://graph.microsoft.com/v1.0/me/` 下相同资源族，拒绝用户信息和 fragment；匹配资源时兼容 slash 与 OData key-segment、资源名大小写及 well-known 文件夹转实际 ID，请求保留服务端 URL 和不透明 query。邮件／文件夹、联系人与日历列表共用该规则，见 [Outlook](../packages/core/src/outlook.ts)、[outlook-features.ts](../packages/core/src/outlook-features.ts)和 [provider-calendar.ts](../packages/core/src/provider-calendar.ts)。联系人遍历范围只在 [Microsoft 配置](setup-microsoft.md#可选服务)维护。

## 草稿与附件

`drafts` 保存本地可编辑草稿，`messages` 保存服务商镜像。草稿本地 ID 为 `draft:<uuid>`；远端草稿／邮件 ID 单独记录，Gmail 和 IMAP 保存后更换服务器 ID 不会改变本地编辑身份。

用户草稿先落本地，再用同一草稿的最新内容推送。队列认领避免桌面、CLI 和 MCP 同时创建服务器副本。打开其他客户端的草稿时通过 MailCodec 解析原始 MIME，保留 HTML、密送和附件；Markdown 来源另存。发送或丢弃清理本地草稿并处理服务器副本，本地未推送改动在拉取时优先保留。

模型提议草稿带 `proposal_id`，MCP 与内置助手草稿先留本机。人在 app 中编辑、保存或发送；上传与批准的边界见[代理使用指南](agents.md)。

原始邮件、附件、内嵌图片经 Mailbox 获取。Node `AttachmentFiles` 实现私有持久缓存、原子写入、容量限制与 LRU；临时打开文件由 desktop 管理，用户保存文件独立于缓存。正文保留期、回填和缓存清理规则见[发布说明](release.md#旧邮件与缓存)。

## Platform 端口

| 能力           | 端口                                                  | Node 实现                                                |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| 文件与路径     | Effect `FileSystem`／`Path`、`AppPaths`               | Node 文件服务和共享数据目录                              |
| 加密           | Effect `Crypto`、`PlatformCrypto`                     | Node 加密与 UUID；纯函数指纹使用可移植 SHA-256           |
| SQL 与恢复     | `SqlClient`、`DatabaseCapabilities`、`DatabaseFiles`  | `node:sqlite`、sqlite-vec、WAL、进程锁与恢复             |
| 密钥与授权     | `Secrets`、`OAuth`、`Browser`、`AppConfig`            | 系统钥匙串、回环 PKCE、系统浏览器、config.json           |
| MIME           | `MailCodec`                                           | mailparser 与 nodemailer composer                        |
| 附件与图片传输 | `AttachmentFiles`、`ImageNetwork`                     | 私有目录、固定解析后的网络地址、逐跳重定向校验与流式限额 |
| 本机媒体与进程 | `InferenceWorker`、`PdfWorker`、`ChildProcessSpawner` | 推理／PDF worker 与进程管理                              |
| 应用签名       | `AppVerifier`                                         | macOS codesign                                           |

`@openmail/core` 是 Node 兼容入口，`@openmail/core/node` 显式导出同一套适配器。`@openmail/core/portable` 导出领域、Mailbox、Store、Gmail／Outlook 与移动 adapters。`@openmail/core/schema` 为 renderer 提供 schema 和纯函数；`@openmail/core/testing/node` 提供临时数据库与 fake provider 的测试组装。

`NodeSystem` 提供 OS 服务，`NodeLayer(options)` 提供完整 Node 平台，`NodeMailbox` 再组装 Store、Providers 和 Mailbox。服务在构建时捕获依赖，返回方法不要求调用方再次提供隐藏 context。缺少必需能力时应提供明确失败的 adapter。导入守卫与逐文件依赖见[平台依赖清单](platform-inventory.md)。

手机端复用迁移、查询、HTTP provider 与策略。op-sqlite、AuthSession、PostalMime adapters 不依赖 React Native；Expo 文件、加密和安全存储由 app Layers 接线。尚未开放的移动能力及原生验证限制见[手机端说明](../apps/mobile/README.md)。

[手机平台组装](../apps/mobile/src/platform/index.ts)关闭 IMAP IDLE、后台队列推送和远端草稿上传。[background.ts](../apps/mobile/src/background.ts) 通过 OS 任务调用 `pollInbox(..., true)`，仅做有预算的 Inbox 增量拉取；本地通知及徽标按设置启用，无远程推送。原生 TCP/TLS 在 [transport.ts](../apps/mobile/src/platform/transport.ts) 接入 core 的传输端口。

## Model 端口

`model.ts` 定义 Model 流式服务、`ModelAnthropic` 与 `FakeModelLayer`。第三方语言模型与本机向量推理 `ModelRuntime` 分开。模型选择以 `ai.ts` 为准。

`mailbox-ai.ts` 维护账户文本授权、密钥、请求、摘要缓存与分拣。账户文本授权、自动摘要和自动分拣默认关闭；API 密钥经 Secrets 保存，界面只读取是否配置。关闭授权清理对应 AI 派生数据并取消请求。Apple Contacts 的进程内快照不进入这些路径，具体隔离见 [Apple Contacts](apple-contacts.md)。

[model-view.ts](../packages/core/src/model-view.ts) 和 [visible-text.ts](../packages/core/src/visible-text.ts) 生成模型消息文本；有 HTML 时优先提取可见文本，再去引用与标准签名，保留来源 ID。本机文本向量沿用该提取器。第三方请求不包含 HTML、图片、附件二进制或媒体派生内容；内置助手进一步移除附件名称与搜索结果中的消息片段，限定本次选中且授权的账户。邮件以转义 JSON 数据送入模型，工具权限由代码决定。隐藏内容、plain alternative 差异与 CSS 检查预算耗尽均有标记；静态提取的边界只在[安全说明](security.md)维护。

摘要与分拣结果存在 `derived`，保存模型、提示词版本和输入哈希。读取缓存时重验；输入变化或授权撤销使结果失效。截断输出不缓存。单次请求最多 24,000 输入预算、1,024 输出 token、4 轮、12 次工具调用，60 秒总超时。

Cmd-J 助手使用 MailToolkit 子集，检索本地邮件与已就绪向量索引，修改只生成提议。撰写 AI 不使用工具、不修改收件人；生成文本先展示差异，用户接受后写入草稿，后续输入会使旧撤销入口失效。自动分拣每批最多三个会话，每账户每分钟一批，仅在前台或接电时运行；接受前重验输入与收件箱状态，用户确认后走 Mailbox。需要回复以星标保存。

本机 OCR、PDF 文本和向量由 Indexer 与 semantic indexer 处理，模型下载及推理通过平台端口运行。媒体索引的开关和输出不授予第三方 AI 文本权限。

## MailToolkit 与入口

`tools.ts` 定义 `ReadMailToolkit`、`ProposalMailToolkit`、合成的 `MailToolkit` 及 `AssistantToolkit`。`AgentIdentity` 提供入口身份，`MailToolkitLayer` 复用 Mailbox；`tool-pages.ts` 统一游标、结果截断和字节预算。

`packages/cli/src/cli.ts` 提供人工命令与工具命令，`mcp-server.ts` 通过 Effect MCP 暴露同一工具集合。默认集合包含读取及显式 sync；sync 会拉取并推送现有队列。开启写工具后只新增整理、稍后提醒与草稿提议，仍须 app 批准。详细工具范围与调用示例只在[代理使用指南](agents.md)维护。

## 桌面与测试

desktop 主进程组装 NodeMailbox、系统能力与 RPC server。`shared/rpc.ts` 定义协议，`shared/mailbox-handlers.ts` 共用 Mailbox 处理器；sandbox preload 只桥接 JSON，renderer 通过 RPC 与 Effect atoms 查询。主入口等 Electron ready 事件，后台索引与初次同步等窗口 `ready-to-show` 后运行。

renderer 的 `App.tsx` 组装邮件界面，`app/` 中的 hooks 管理选择、撰写、动作、快捷键、布局与原生菜单，`state/` 管理查询、事件及撤销，`components/` 实现邮件、设置与按需加载的对话框。语言目录也按需加载。

`src/renderer/src/e2e/harness.ts` 在 jsdom 中渲染真实 App，经过 preload 同款 RPC 和共用处理器连接真实 Mailbox 与临时 SQLite。服务商使用 fake，桌面窗口、剪贴板和原生服务使用支架。它验证界面到数据库／provider 的邮件流程；Electron、真实授权和签名验收另列在[路线图](roadmap.md)。测试入口及故障注入只在[测试](testing.md)维护。
