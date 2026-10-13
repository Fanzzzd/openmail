# 架构

core 负责邮件网络、数据库、策略和同步。桌面、CLI、MCP 与手机界面调用 Mailbox，平台能力通过 Effect 服务提供。术语见 [CONTEXT.md](../CONTEXT.md)，源码约束只在 [AGENTS.md](../AGENTS.md)维护。

## 源码地图

core 的源码按领域分目录，划分理由见 [ADR 0001](adr/0001-core-layout.md)。`packages/core/src` 顶层只放包入口，`platform-imports.test.ts` 检查这一点。测试和被测文件放在同一目录。

| 目录                     | 内容                                                                                                | 从这里读起                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 顶层                     | 包入口：`index.ts`（Node）、`portable.ts`（手机）、`schema.ts`（renderer）、`common.ts`（共享导出） | `index.ts`                                      |
| `domain/`                | 领域 schema 与错误：账户、消息、改动、设置、Command／Actor／Outcome、文件夹操作                     | `domain/message.ts`、`domain/command.ts`        |
| `mailbox/`               | Mailbox 服务与 `mailbox-*.ts` 子模块、策略、只读会话、撤销记录、发件箱                              | `mailbox/mailbox.ts`、`mailbox/mailbox-live.ts` |
| `store/`                 | Store 端口与 `store-*.ts` 查询                                                                      | `store/service.ts`、`store/store.ts`            |
| `db/`                    | 只追加的迁移、迁移执行、搜索标志位 SQL、数据库能力                                                  | `db/migrations.ts`                              |
| `sync/`                  | 同步健康报告、同步重置、失败分类、邮件头回填、退避                                                  | `sync/sync-health.ts`                           |
| `providers/`             | ProviderAdapter 端口、HTTP 重试、诊断、可选服务、OAuth client                                       | `providers/adapter.ts`                          |
| `providers/gmail/`       | Gmail 适配器：`api`、`client`、`pull`、`history`、`labels`、`send`、`parse`，`gmail.ts` 组装        | `providers/gmail/gmail.ts`                      |
| `providers/outlook/`     | Outlook 适配器与 Graph 分页；发送拆为草稿状态、草稿和发送                                           | `providers/outlook/outlook.ts`                  |
| `providers/imap/`        | 两端共用的 IMAP 游标、预设、IDLE 调度                                                               | `providers/imap/imap-cursor.ts`                 |
| `calendar/`、`contacts/` | 日历事件、重复规则、邀请、Windows 时区表；联系人与 Apple Contacts 快照                              | `calendar/calendar.ts`                          |
| `compose/`               | 撰写正文（节点、Markdown、发送转换）、签名、收件人、Markdown 草稿                                   | `compose/compose-body.ts`                       |
| `mime/`                  | MIME 解析、TNEF、附件策略、Message-ID                                                               | `mime/mime.ts`                                  |
| `reader/`                | 阅读 HTML 清洗、跟踪器、链接与发件人安全、打印                                                      | `reader/reading.ts`                             |
| `visible-text/`          | 模型消息文本的可见文本提取：上下文、规则、绘制器、CSS                                               | `visible-text/visible-text.ts`                  |
| `search/`                | 查询解析、字段、FTS、排名、服务商搜索                                                               | `search/search.ts`                              |
| `ai/`                    | Model、本机索引、向量检索、模型消息视图                                                             | `ai/model.ts`、`ai/model-view.ts`               |
| `tools/`                 | MailToolkit：每组工具一个 `*-tools.ts`，`tools.ts` 合成工具集与处理器                               | `tools/tools.ts`                                |
| `app/`                   | 桌面集成：链接与通知判断、更新、远程访问、反馈                                                      |                                                 |
| `platform/`              | 平台端口；`platform/node/` 是 Node 实现，`platform/react-native/` 是手机 adapters                   | `platform/auth.ts`、`platform/runtime.ts`       |

桌面、CLI 与手机：

| 位置                             | 内容                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/`         | 主进程，按领域分 `app/`、`windows/`、`rpc/`、`security/`、`files/`、`updates/`、`system/`、`remote/`、`agents/`      |
| `apps/desktop/src/shared/`       | main 与 renderer 共用：RPC 协议 `rpc.ts`、Mailbox 处理器、路由、远程策略                                             |
| `apps/desktop/src/renderer/src/` | renderer，分层规则见下文[桌面与测试](#桌面与测试)                                                                    |
| `packages/cli/src/`              | `cli.ts` 组装并运行；`commands/` 按组放命令：`accounts`、`mail`、`agents`、`tools`、`corpus`；`mcp-server.ts` 是 MCP |
| `apps/mobile/`                   | Expo 应用，`src/platform/` 提供 OS Layers                                                                            |

导入环由 oxlint 的 `import/no-cycle`（`ignoreTypes: false`）拦截，类型导入构成的环同样报错。非生成源文件控制在约 800 行以内，例外见 ADR。

## 当前模块

| 模块            | 入口与职责                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox         | `mailbox/mailbox.ts` 定义 Effect 服务；`mailbox/mailbox-live.ts` 组装同步、队列、策略和事件                                                                                                                                                     |
| Mailbox 子模块  | `mailbox/` 下的 `mailbox-batch.ts`、`mailbox-folders.ts`、`mailbox-cache.ts`、`mailbox-features.ts`、`mailbox-organization.ts`、`mailbox-filters.ts`、`mailbox-ai.ts` 分别实现批量、破坏性文件夹操作、缓存、日历／联系人、整理、服务商规则与 AI |
| Store           | `store/service.ts` 定义端口，`store/store.ts` 与 `store/store-*.ts` 实现查询；`db/migrations.ts` 保存追加迁移，`db/capabilities.ts` 描述数据库能力                                                                                              |
| ProviderAdapter | `providers/adapter.ts` 定义接口；`providers/gmail/gmail.ts`、`providers/outlook/outlook.ts` 和 `platform/node/imap/adapter.ts` 实现协议                                                                                                         |
| 模型与工具      | `ai/model.ts` 提供 Model；`tools/tools.ts` 提供 MailToolkit；`tools/tool-pages.ts` 处理游标和预算                                                                                                                                               |
| 本机索引        | `ai/indexer.ts`、`ai/semantic-indexer.ts` 与 media／semantic Store 处理派生文本及向量                                                                                                                                                           |
| Node 平台       | `platform/node/` 实现数据库、密钥、OAuth、IMAP/SMTP、MIME、文件、PDF 和推理 worker                                                                                                                                                              |
| 手机平台        | `platform/react-native/` 提供 SQL／OAuth／MIME／IMAP/SMTP adapters；Expo OS Layers 在 `apps/mobile/src/platform/`                                                                                                                               |

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
| `queueUndoSend`、`awaitUndoSend`、`cancelQueuedSend`               | 桌面持久撤销发送；等待与交付由 core 管理                    |
| `sync(accountId?)`、`pollInbox`                                    | 完整同步和轻量收件箱轮询；CLI/MCP 不启动桌面轮询计时器      |
| `listFailedOps`、`acknowledgeFailedOps`、`prepareRejectedResend`   | 查询、关闭失败提示及准备仅向拒收地址重发的新草稿            |
| `syncHealth(accountId)`                                            | 只读服务商计数与本地投影，返回同步健康报告                  |
| `optionalServices`、`reauth`、`setServiceEnabled`                  | 查询服务授权、走官方同意页及控制本机启停                    |
| `events`                                                           | `Changed`、同步状态／进度、新邮件、回填进度和更新设置事件流 |

其余账户、Profiles、设置、联系人、日历、缓存与 AI 方法以 `mailbox/mailbox.ts` 为准。永久删除与清空文件夹走独立的确认接口，不放入模型工具的普通 MailOp。

### 策略与改动

`domain/command.ts` 定义 Command、Actor 和 Outcome，`mailbox/policy.ts` 的 `decide` 根据入口与写权限判断。用户操作走执行路径；规则按权限直接执行或提议。MCP 和内置助手的写入须审批，代理发送不能直接执行。工具开关与审批细节只在[代理使用指南](agents.md#提议改动)维护。

普通修改在 core 展开会话，应用本地状态，记录 `pending_ops` 与 `audit_log`，再尝试推送服务商。重试、认领、失败提示与发送结果规则只在[同步说明](sync-correctness.md#出站操作队列)维护。同步落库保留待推送操作的本地结果，避免拉取覆盖离线改动。

批量路径记录逐封逆向状态。`mailbox/undo-journal.ts` 持久保存记录，重启后仍可查询；撤销前检查消息状态，防止覆盖后续操作。删除服务商规则的恢复记录另存，不混入邮件撤销。

### 只读会话

`OPENMAIL_READ_ONLY=1` 在 Layer 构建时读取。Node Providers 和 portable Mailbox 均包裹 [read-only.ts](../packages/core/src/mailbox/read-only.ts) 的 adapter，只放行已列出的读取与连接方法；未知方法及 accessor 默认拒绝。邮件、文件夹、规则、自动回复、日历、草稿上传、发送和一键退订 POST 均受拦截。队列刷新跳过既有操作，延迟发送不执行，待处理项保留原状态。

本地偏好、草稿、已读状态和提议仍可保存。该开关不隔离数据库，也不阻止网络读取、标准 Secrets 读取或 token 刷新，不扩大 OAuth scopes。组装与队列入口见 [Node Layers](../packages/core/src/platform/node/layers.ts) 和 [mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts)，回归见 [read-only.test.ts](../packages/core/src/mailbox/read-only.test.ts)。使用数据库副本的运行方式只在[测试](testing.md#桌面生产构建-smoke)维护。

### 可选服务

[optional-services.ts](../packages/core/src/providers/optional-services.ts) 定义基础及分服务 scopes，`scopedAdapter` 在 provider 调用前检查授权和本机开关。联系人、日历和服务商设置互不替代，缺权限不暂停邮件同步。只有显式停用联系人会清除服务器联系人、分组和照片，本地往来地址仍保留。授权兼容规则见 [store-services.ts](../packages/core/src/store/store-services.ts)，启停见 [mailbox-services.ts](../packages/core/src/mailbox/mailbox-services.ts)。配置和 scope 表只在 [Google](setup-google.md#可选服务) 与 [Microsoft](setup-microsoft.md#可选服务)维护。

### Provider 与 Store

`ProviderAdapter.pull` 返回 `Stream<Change>`，Mailbox 统一消费邮件、删除、标签与游标变更。适配器提供 push、send、草稿、附件、搜索、联系人与日历等方法。Gmail 和 Outlook 使用可移植 HTTP；IMAP/SMTP 分别由 [Node adapter](../packages/core/src/platform/node/imap/adapter.ts) 和[手机 adapter](../packages/core/src/platform/react-native/imap.ts)实现。

Store 使用 Effect `SqlClient`。Node Layer 提供 `node:sqlite` 与可选 sqlite-vec；手机 Layer 提供 op-sqlite 并报告向量能力不可用。两端运行同一 `MIGRATIONS`。消息经 `upsertMessage` 更新，保留 rowid 与外部内容 FTS 的对应。词索引、trigram、徽标及联系人投影用于查询，性能证据见[性能](performance.md)。

[db/migrations.ts](../packages/core/src/db/migrations.ts) 的 `MIGRATIONS` 只追加，schema 版本等于它的条数，新迁移接在末尾。近期迁移中，31 保存邮件头与词位置视图，32 保存认证结果及安全退订目标，33 保存本机可选服务开关，34 增加消息文本字节数、运行总量和 LRU 索引；35 调整 provider ID 与列表日期覆盖索引，并增加 IMAP 路径、孤立远端草稿和消息文本字节数索引。36 保存出站重试与复制进度、认领 token、APPEND 身份和失败提示。之后各条的用途见 `db/migrations.ts` 中的注释。索引的读取收益、写入与空间成本只在[性能](performance.md#写入与磁盘成本)维护。消息文本容量预算默认关闭，启用后每小时或额度变更时回收；保留期限、星标、草稿和发件箱优先，额度不保证覆盖受保护内容。它不限制整个数据库或所有附件占用，见 [store-cache.ts](../packages/core/src/store/store-cache.ts)。

slice 56 已合入同步重置删除保护。slice 62 将所有重置删除候选纳入持久验证队列，验证失败保留；实现见 [sync-reset.ts](../packages/core/src/sync/sync-reset.ts)和 [store-sync-reset.ts](../packages/core/src/store/store-sync-reset.ts)。slice 60 增加独立预算的过期缓存扫描与持久 Outlook 冲突验证，仍不按计数差直接删除。删除范围、扫描预算、Outlook delta 页大小、UID 身份隔离、发送结果与同步健康报告只在[同步说明](sync-correctness.md)维护。

[graph-pagination.ts](../packages/core/src/providers/outlook/graph-pagination.ts) 校验 Graph 列表续页链接：仅接受 `https://graph.microsoft.com/v1.0/me/` 下相同资源族，拒绝用户信息和 fragment；匹配资源时兼容 slash 与 OData key-segment、资源名大小写及 well-known 文件夹转实际 ID，请求保留服务端 URL 和不透明 query。邮件／文件夹、联系人与日历列表共用该规则，见 [Outlook](../packages/core/src/providers/outlook/outlook.ts)、[outlook-features.ts](../packages/core/src/providers/outlook/outlook-features.ts)和 [provider-calendar.ts](../packages/core/src/calendar/provider-calendar.ts)。联系人遍历范围只在 [Microsoft 配置](setup-microsoft.md#可选服务)维护。

## 草稿与附件

`drafts` 保存本地可编辑草稿，`messages` 保存服务商镜像。草稿本地 ID 为 `draft:<uuid>`；远端草稿／邮件 ID 单独记录，Gmail 和 IMAP 保存后更换服务器 ID 不会改变本地编辑身份。

用户草稿先落本地，再用同一草稿的最新内容推送。队列认领避免桌面、CLI 和 MCP 同时创建服务器副本。打开其他客户端的草稿时通过 MailCodec 解析原始 MIME，保留 HTML、密送和附件；Markdown 来源另存。发送或丢弃清理本地草稿并处理服务器副本，本地未推送改动在拉取时优先保留。

创建日志、远端版本冲突、部分保存失败和发送意图恢复的规则见[同步说明](sync-correctness.md#草稿与其他写入)。

模型提议草稿带 `proposal_id`，MCP 与内置助手草稿先留本机。人在 app 中编辑、保存或发送；上传与批准的边界见[代理使用指南](agents.md)。

原始邮件、附件、内嵌图片经 Mailbox 获取。Node `AttachmentFiles` 实现私有持久缓存、原子写入、容量限制与 LRU；临时打开文件由 desktop 管理，用户保存文件独立于缓存。正文保留期、回填和缓存清理规则见[发布说明](release.md#旧邮件与缓存)。

## Platform 端口

| 能力           | 端口                                               | Node 实现                                                |
| -------------- | -------------------------------------------------- | -------------------------------------------------------- |
| 文件与路径     | Effect `FileSystem`／`Path`、`AppPaths`            | Node 文件服务和共享数据目录                              |
| 加密           | Effect `Crypto`、`PlatformCrypto`                  | Node 加密与 UUID；纯函数指纹使用可移植 SHA-256           |
| SQL 与恢复     | `SqlClient`、`DatabaseCapabilities`                | `node:sqlite`、sqlite-vec、WAL、进程锁与恢复             |
| 密钥与授权     | `Secrets`、`OAuth`、`Browser`、`AppConfig`         | 系统钥匙串、回环 PKCE、系统浏览器、config.json           |
| MIME           | `MailCodec`                                        | mailparser 与 nodemailer composer                        |
| 附件与图片传输 | `AttachmentFiles`、`ImageNetwork`                  | 私有目录、固定解析后的网络地址、逐跳重定向校验与流式限额 |
| 本机媒体与进程 | `ModelRuntime`、`PdfWorker`、`ChildProcessSpawner` | 推理／PDF worker 与进程管理                              |
| 应用签名       | `AppVerifier`                                      | macOS codesign                                           |

`@openmail/core` 是 Node 兼容入口，`@openmail/core/node` 显式导出同一套适配器。`@openmail/core/portable` 导出领域、Mailbox、PortableMailbox 与移动 adapters。`@openmail/core/schema` 为 renderer 提供 schema 和纯函数；`@openmail/core/testing/node` 提供 Store、StoreLive、临时数据库与 fake provider 的测试组装。Store 只在 core 内部使用，外部生产代码通过 Mailbox 调用。

`NodeSystem` 提供 OS 服务，`NodePlatform(options)` 提供完整 Node 平台，`NodeMailbox` 再组装 Store、Providers 和 Mailbox。服务在构建时捕获依赖，返回方法不要求调用方再次提供隐藏 context。缺少必需能力时应提供明确失败的 adapter。导入守卫与逐文件依赖见[平台依赖清单](platform-inventory.md)。

手机端复用迁移、查询、HTTP provider 与策略。op-sqlite、AuthSession、PostalMime adapters 不依赖 React Native；Expo 文件、加密和安全存储由 app Layers 接线。尚未开放的移动能力及原生验证限制见[手机端说明](../apps/mobile/README.md)。

[手机平台组装](../apps/mobile/src/platform/index.ts)关闭 IMAP IDLE、后台队列推送和远端草稿上传。[background.ts](../apps/mobile/src/background.ts) 通过 OS 任务调用 `pollInbox(..., true)`，仅做有预算的 Inbox 增量拉取；本地通知及徽标按设置启用，无远程推送。原生 TCP/TLS 在 [transport.ts](../apps/mobile/src/platform/transport.ts) 接入 core 的传输端口。

## Model 端口

`ai/model.ts` 定义 Model 流式服务、`ModelAnthropic` 与 `FakeModelLayer`。第三方语言模型与本机向量推理 `ModelRuntime` 分开。模型选择以 `ai/ai.ts` 为准。

`mailbox/mailbox-ai.ts` 维护账户文本授权、密钥、请求、摘要缓存与分拣。账户文本授权、自动摘要和自动分拣默认关闭；API 密钥经 Secrets 保存，界面只读取是否配置。关闭授权清理对应 AI 派生数据并取消请求。Apple Contacts 的进程内快照不进入这些路径，具体隔离见 [Apple Contacts](apple-contacts.md)。

[model-view.ts](../packages/core/src/ai/model-view.ts) 和 [visible-text.ts](../packages/core/src/visible-text/visible-text.ts) 生成模型消息文本；有 HTML 时优先提取可见文本，再去引用与标准签名，保留来源 ID。本机文本向量沿用该提取器。第三方请求不包含 HTML、图片、附件二进制或媒体派生内容；内置助手进一步移除附件名称与搜索结果中的消息片段，限定本次选中且授权的账户。邮件以转义 JSON 数据送入模型，工具权限由代码决定。隐藏内容、plain alternative 差异与 CSS 检查预算耗尽均有标记；静态提取的边界只在[安全说明](security.md)维护。

摘要与分拣结果存在 `derived`，保存模型、提示词版本和输入哈希。读取缓存时重验；输入变化或授权撤销使结果失效。界面把当前语言（BCP 47，如 `zh-CN`）传给摘要、提问和撰写，提示词要求按该语言输出；摘要的提示词版本带上语言，换语言即缓存未命中。后台的自动摘要和分拣理由用设置里的语言，设为跟随系统时用桌面主进程给的系统语言。CLI 和 MCP 不传语言。钥匙串读不出 API 密钥时，`aiSettings` 仍返回逐账户授权，另以 `keyUnreadable` 标记，设置页不会因此误报没有账户允许 AI 读取。截断输出不缓存。单次请求最多 24,000 输入预算、1,024 输出 token、4 轮、12 次工具调用，60 秒总超时。

Cmd-J 助手使用 MailToolkit 子集，检索本地邮件与已就绪向量索引，修改只生成提议。撰写 AI 不使用工具、不修改收件人；生成文本先展示差异，用户接受后写入草稿，后续输入会使旧撤销入口失效。自动分拣每批最多三个会话，每账户每分钟一批，仅在前台或接电时运行；接受前重验输入与收件箱状态，用户确认后走 Mailbox。需要回复以星标保存。

本机 OCR、PDF 文本和向量由 Indexer 与 semantic indexer 处理，模型下载及推理通过平台端口运行。媒体索引的开关和输出不授予第三方 AI 文本权限。

## MailToolkit 与入口

`tools/tools.ts` 定义 `ReadMailToolkit`、`ProposalMailToolkit`、合成的 `MailToolkit` 及 `AssistantToolkit`。每组工具及其处理器在一个 `tools/*-tools.ts` 里：账户、会话、撰写、日历、附件和提议。`AgentIdentity` 提供入口身份，`MailToolkitLayer` 复用 Mailbox；`tools/tool-pages.ts` 统一游标、结果截断和字节预算。

`packages/cli/src/cli.ts` 组装 `commands/` 下的人工命令与工具命令，`mcp-server.ts` 通过 Effect MCP 暴露同一工具集合。默认集合包含读取及显式 sync；sync 会拉取并推送现有队列。开启写工具后只新增整理、稍后提醒与草稿提议，仍须 app 批准。详细工具范围与调用示例只在[代理使用指南](agents.md)维护。

## 桌面与测试

desktop 主进程组装 NodeMailbox、系统能力与 RPC server。`shared/rpc.ts` 定义协议，`shared/mailbox-handlers.ts` 共用 Mailbox 处理器；sandbox preload 只桥接 JSON，renderer 通过 RPC 与 Effect atoms 查询。主入口等 Electron ready 事件，后台索引与初次同步等窗口 `ready-to-show` 后运行。

主进程源码按领域分目录：`app/` 启动、退出、恢复与本机推理，`windows/` 窗口、菜单与拼写，`rpc/` RPC server，`security/` 协议、外链与 OAuth client，`files/` 附件、下载与拖放，`updates/` 自动更新，`system/` 通知、通讯录、默认邮件程序与原生撰写。`index.ts` 是 electron-vite 入口。`new URL(…, import.meta.url)` 按打包后的 `out/main/index.js` 解析，移动源文件不改这些路径。

renderer 源码分层，依赖只向下：

| 目录               | 内容                                                                                                                                                                                                          | 不得导入                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `routes/`          | TanStack Router 的代码路由、`router.ts` 和 `AppRouterProvider`；只由 `main.tsx` 与测试导入                                                                                                                    |                                                 |
| `app/`             | `App.tsx`、`ThreadWindow.tsx`、面板、窗口快捷键、`location-bridge.tsx` 和组装界面的 hooks                                                                                                                     | `routes/`                                       |
| `features/<name>/` | 一个功能一个目录：mail-list、reader（含 body、frame、attachments）、compose、search、sidebar、organize、settings、accounts、contacts、ai、calendar、downloads、sync-status、updates、undo、overview、feedback | `routes/`、`app/`                               |
| `state/`           | RPC client、查询、mutation、事件、撤销和 `location.ts`（窗口路由的 atoms）                                                                                                                                    | `routes/`、`app/`、`features/`                  |
| `i18n/`            | Lingui 初始化、`LocaleProvider` 和共享文案                                                                                                                                                                    | `routes/`、`app/`、`features/`                  |
| `ui/`              | 共享 React 组件：Dialog、Menu、Select、Toast 等                                                                                                                                                               | `routes/`、`app/`、`features/`、`state/`        |
| `lib/`             | 纯函数和通用 hooks，不读取 RPC 或 atoms                                                                                                                                                                       | `routes/`、`app/`、`features/`、`state/`、`ui/` |

oxlint 的 `no-restricted-imports` 执行上表。`tests/layers.test.ts` 从两个 HTML 入口遍历导入图，检查三条规则：

- `import()` 加载的模块不在启动即加载的图里。
- 功能目录的 `index.ts` 只导出启动即加载的模块，否则导入这个 index 就会连带加载懒加载代码。
- 一个功能经对方的 `index.ts` 导入另一个功能。只存在于懒加载 chunk 的模块（如 `EmailFrame`、`ComposeEditor`、`OptionalServices`）直接按路径导入。

功能自己打开的懒加载对话框放在该功能的 `lazy.tsx`，`app/LazyDialogs.tsx` 只放 `app/` 打开的对话框。`recovery/` 是恢复窗口的独立入口。跨层测试放在 `tests/`，测试工具放在 `test-support/`，其余测试与源文件放在一起。文件移动保留文件名，因为 `bundle-split.test.ts` 按 chunk 名检查拆包。语言目录按需加载。

窗口内导航只走 TanStack Router 的代码路由，app 用 hash history，测试用 memory history。路由表：

| 路由                    | 界面                          | search 参数                                                                           |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `/`                     | 跳转到本窗口最近的视图        |                                                                                       |
| `/mail/$space/$mailbox` | 主窗口 `App`                  | `account`、`label`（`账户/标签` 或类别）、`q`、`scope`、`thread`、`message`、`dialog` |
| `/thread/$threadId`     | 会话或单封窗口 `ThreadWindow` | `single=1` 只显示这一封                                                               |
| `/compose/$draftId`     | 独立撰写窗口                  |                                                                                       |

`shared/routes.ts` 构造和解析 href，不导入路由库，main 与 renderer 共用。无效 search 参数退回默认值；未知文件夹跳到该空间的收件箱。main 用它生成窗口 URL（`index.html?systemLanguages=…#/thread/x?single=1`），把主窗口路由存进 `windows.json` 的 `href`，并把链接、通知、托盘和 Dock 菜单转成 `Navigate` 事件。renderer 只接受邮件路由。`app/location-bridge.tsx` 把每次 history 变化同步到 `state/location.ts` 的 `locationAtom`，视图、搜索、打开的会话和对话框都从它派生，写入时调用 router。换视图新增历史记录，立即写入；选会话、提交搜索和开关对话框替换当前记录，`routes/router.ts` 的 `historyFor` 把连续的替换合并，停 300ms 后写一次 URL。Chromium 每 10 秒只接受约 200 次 history 写入，按住方向键不合并会超限。打不开的链接由 main 发 `LinkError`，renderer 显示提示。多选、标签选择器、稍后提醒等临时状态留在各功能的 atoms 里。

`src/renderer/src/e2e/harness.ts` 在 jsdom 中渲染真实 App，经过 preload 同款 RPC 和共用处理器连接真实 Mailbox 与临时 SQLite。服务商使用 fake，桌面窗口、剪贴板和原生服务使用支架。它验证界面到数据库／provider 的邮件流程；Electron、真实授权和签名验收另列在[路线图](roadmap.md)。测试入口及故障注入只在[测试](testing.md)维护。
