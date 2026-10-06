# core 平台依赖清单

修改 core 平台实现、打包入口或手机 Layer 时读取。导入边界规则在 AGENTS.md，禁止的包名以 `.oxlintrc.json` 为准。`platform-imports.test.ts` 读取该配置，另检查 Node 内置模块和 portable 的本地依赖图。

对原有 `packages/core/src` 的审计包括静态、类型、动态导入及 `.mjs` worker。生产 Node 实现现在全部位于 `platform/node/`；进程测试 fixture、fake provider 和 SQLite 内存测试平台也放在此目录。

| 原文件                                                               | 原平台依赖                                                | 处理                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `compose-images.ts`                                                  | dns/promises、http、https、net、crypto                    | 校验和流式限额留在 core；`ImageNetwork` 的 Node adapter 固定解析后的地址，UUID 来自 `PlatformCrypto` |
| `database-access.ts`                                                 | fs、path、sqlite                                          | Node 数据库进程锁 adapter                                                                            |
| `database-recovery.ts`                                               | crypto、fs、path、sqlite                                  | Node 恢复 adapter，直接提供数据库完整文件操作                                                        |
| `recovery-files.ts`                                                  | fs、path、sqlite                                          | Node WAL、恢复文件及锁处理                                                                           |
| `diagnostics.ts`                                                     | crypto、fs、path、sqlite                                  | Node 本地诊断及数据库检查                                                                            |
| `db.ts`                                                              | @effect/sql-sqlite-node、sqlite-vec                       | 迁移、SQL 初始化、能力标签留在 core；连接、扩展加载和锁在 Node adapter                               |
| `embeddings-node.ts`                                                 | path、url、推理进程                                       | Node 模型 adapter，launcher 可由 `NodeModelsOptions.launch` 替换                                     |
| `inference-process.ts`                                               | child_process                                             | fork adapter；推理进程协议在可移植平台端口                                                           |
| `embedding-worker.mjs`                                               | module、path、onnxruntime-node、@huggingface/transformers | Node worker，保留原资源预算和离线限制                                                                |
| `model-downloads.ts`                                                 | crypto、fs、fs/promises、path                             | Node 下载文件 adapter，保留哈希、续传和租约                                                          |
| `pdf-text.ts`、`pdf-worker.mjs`                                      | worker_threads、url、pdfjs-dist                           | `PdfWorker` 的 Node adapter，保留超时、页数、内存及离线限制                                          |
| `mailbox-ai.ts`、`mailbox-live.ts`                                   | crypto                                                    | 平台中立的同步 SHA-256；UUID 从构建时捕获的 `PlatformCrypto` 获取                                    |
| `markdown-draft.ts`、`provider-calendar.ts`、`tool-pages.ts`         | crypto                                                    | 可移植同步指纹，算法和编码保持不变                                                                   |
| `oauth.ts`                                                           | http                                                      | `OAuth` 的 Node 回环 adapter，现有 PKCE 和 scope 不变                                                |
| `paths.ts`                                                           | os、process.platform                                      | Node 目录规则；可移植 core 读取 `AppPaths`                                                           |
| `persistent-attachments.ts`                                          | crypto、fs、fs/promises、path                             | `AttachmentFiles` 的 Node adapter                                                                    |
| `updates.ts`                                                         | child_process、util                                       | 更新策略留在 core，codesign 移入 `AppVerifier` adapter                                               |
| `platform-node.ts`                                                   | @effect/platform-node 的文件、路径、加密及进程服务        | Node 层组装；Effect v4 已把标准端口放在 effect 包中                                                  |
| `secrets.ts`                                                         | @napi-rs/keyring                                          | `Secrets` 的 Node adapter；可移植文件只保留密钥名                                                    |
| `compose.ts`                                                         | nodemailer/lib/mail-composer                              | `MailCodec.build` 的 Node adapter                                                                    |
| `attachments.ts`、`drafts.ts`、`invites.ts`、`reader-attachments.ts` | mailparser；drafts 还经 imap 读地址                       | 解析调用 `MailCodec.parse`；附件、草稿、日历和阅读逻辑留在 core                                      |
| `imap.ts`、`imap-search.ts`、`imap-idle.ts`                          | imapflow、mailparser、nodemailer                          | IMAP/SMTP、查询编译和 socket 留在 Node provider；cursor 及 IDLE 调度留在 core                        |
| `resettable-loader.mjs`                                              | 随 Node worker 部署                                       | 同 worker 一起移动和复制                                                                             |
| `fixtures/migration-open.mjs`                                        | fs、sqlite、Node 驱动                                     | Node 进程测试 fixture                                                                                |
| `layers.ts`、`platform-memory.ts`、`testing.ts`、`fake-provider.ts`  | 间接依赖 Node 驱动或 MIME composer                        | Node 组装与测试适配器                                                                                |

Node 专用包包括 `@effect/platform-node`、`@effect/platform-node-shared`、`@effect/sql-sqlite-node`、`@napi-rs/keyring`、`sqlite-vec`、`onnxruntime-node`、`imapflow`、`nodemailer`、`mailparser`、`pdfjs-dist`。当前 Transformers 的模型 worker 也限定在 Node adapter；手机端未提供 `ModelRuntime`，端侧推理不支持，原因见手机端说明。`better-sqlite3` 同样在禁止清单，桌面仍使用 `node:sqlite`。

core 的字节操作集中到 `platform/bytes.ts`，Node 选用原生 Buffer，缺少该全局对象时回退到 `buffer/index.js` 的浏览器实现。该模块的 native Buffer 探测由导入守卫检查，边界规则见 AGENTS.md。base64url 明确转换字母表及 padding。TNEF 直接使用 Uint8Array / DataView，共享有界输入；UTF-16LE 手工保留 BOM 和独立代理码元，丢弃末尾单字节，保持原生 Buffer 的解码结果。同步 SHA-256 / HMAC 使用 `@noble/hashes` 的可移植实现，Node 的 `PlatformCrypto` 使用原生加密；随机数服务须由手机安全随机实现提供。

手机端待办以[路线图](roadmap.md#core-平台接口)为准。已添加 Expo 项目、无 RN 依赖的 core op-sqlite/OAuth/provider/MIME adapters，以及手机端 Expo OS Layers，入口见[手机端说明](../apps/mobile/README.md)。portable 入口在 通过浏览器平台打包。导入检查证明 core 的本地模块边界，不代替 React Native 真机验证、第三方包的 Metro 打包验证或 op-sqlite 的兼容性检查。

阅读 HTML 的 CSS 清洗和可见文本提取直接导入 `css-tree/dist/csstree.esm`。css-tree 3.2.1 的 `exports["./dist/*"]` 指向 `./dist/*.js`，该入口是完整浏览器 ESM 包，不依赖根入口的 `module.createRequire`；因此不依赖 Metro 对根入口 `browser` 字段的重定向。手机 `metro.config.cjs` 使用 Expo 默认解析器，未改写此包的解析。`platform/node/css-browser.test.ts` 验证导出映射、浏览器包及实际 CSS 解析；本 slice 未运行 Metro。

MailCodec、PdfWorker、AttachmentFiles、ImageNetwork 是必需的 Effect services，缺少 Layer 会在类型检查中报错。provider、阅读附件和 indexer 构建时捕获依赖，返回的方法不读调用方的隐藏 context。真实 NodeMailbox 回归测试覆盖 IMAP 原始 MIME fallback、正文/日历/嵌套附件、PDF 索引、文件缓存、图片输入和 SSRF 拒绝；仅替换 IMAP 传输和合成密码，使用临时数据库，不启动 Electron。

手机数据库恢复位于 `platform/react-native/database-recovery.ts`，通过 `MobileDatabaseRecovery`、Effect FileSystem、AppPaths、PlatformCrypto 和结构化 op-sqlite 端口实现。用户表清单在 `platform/recovery-tables.ts`，两端共用。手机 OS 组装在 `apps/mobile/src/platform/database-recovery.ts`，前台和 headless 数据库共用恢复门；前台检查的结果与时间由 Effect FileSystem 持久保存，冷后台启动可复用未过期的成功记录。SQLite shim 只在 `packages/core/test-support`，不进入生产 build。完整性检查、隔离、抢救、provider 重同步与中断边界见[手机数据库说明](../apps/mobile/README.md#数据库)。

手机 `PdfWorker` 和 `ImageNetwork` 的 no-op Layer 在 `platform/react-native/media.ts`，明确返回 unavailable。PDF.js 的现有 worker 不适用于 Hermes；手机无固定地址图片导入入口，fetch 不能替代 DNS pinning。阅读器继续使用 shouldLoadRemote／HTTPS CSP；端侧推理未实现。详细预算、安全规则和原因只在[手机媒体说明](../apps/mobile/README.md#媒体适配边界)维护。这些 adapters 不调用 Node、转换服务或云端媒体推理。

portable IMAP／SMTP 协议位于 `platform/react-native/imap.ts`，`MailTransport` 只暴露 TCP/TLS 字节流，手机原生实现位于 `apps/mobile/src/platform/transport.ts`。账户预设解析由两端共用 `imap-settings.ts`，密码仍经 Secrets。Expo 附件缓存与临时分享副本位于手机沙箱 cache，core 的 AttachmentFiles 仍负责容量、清理与版本失效；未增加数据库迁移。原生 TLS 证书主机名校验、Android 读取线程同步及两端握手完成事件补丁随 pnpm 锁文件安装。具体能力及验证边界见[手机端能力表](../apps/mobile/README.md#能力)。

开发 smoke 的数据库复制与副本迁移在 `platform/node/smoke.ts`，桌面脚本只调用该 core 导出。`OPENMAIL_READ_ONLY=1` 经 Effect Config 在 core Layer 构建时读取；provider 写入拦截与队列／发送策略见 `read-only.ts`、`mailbox-live.ts`，没有引入隐式 Node 全局。

共享导出集中在 `common.ts`。Node 入口只重导出桌面／CLI 消费的名称，不经 `portable.ts` 加载手机 adapters 或手机专用工作流；`platform-imports.test.ts` 检查该依赖图。手机端继续从 `portable.ts` 获得共享能力和移动平台组装。

可见文本先对阅读器清洗结果和参考 shell 使用 parse5 8.0.1 做 HTML5 解析，再经 parse5-htmlparser2-tree-adapter 8.0.1 接入现有选择器与遍历器。两个入口均为纯 ESM 解析代码，不调用 Node 平台服务；表格 foster-parenting 回归验证与浏览器解析一致。本次不运行 Electron 或 Metro。

## IMAP 两端行为差异

修改 IMAP provider 或讨论两端能力一致性时读取。Slice 71 只提取相同的纯函数，并拆分 Node 模块；以下九项保留原行为，需要产品决定后再统一。

| 项目           | Node                                                          | React Native                                                                  |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 特殊文件夹识别 | 使用服务器 special-use；普通文件夹保留路径标签                | 另用 Sent Items、Deleted Items 等名称别名识别特殊文件夹                       |
| 大消息同步     | 超过 10 MB 时读取前 512 KB，附件信息来自 BODYSTRUCTURE        | 下载完整消息，超过 25 MB 拒绝；不做截断解析                                   |
| 标记增量       | 已启用 CONDSTORE 时用 changedSince，另查存在的 UID            | 依据 capability 和时间决定扫描，读取全部已知 UID 的 FLAGS                     |
| 搜索范围       | 编译服务器搜索条件后拉取并复核消息                            | 搜索 UNDELETED，从新到旧读取并本地匹配，最多扫描 1000 条                      |
| 附件下载       | 优先单独下载 BODYSTRUCTURE 对应 MIME part，必要时回退原始消息 | 下载整封消息，再解析并选取附件                                                |
| 远程草稿       | 支持 APPEND、替换、组织标记、冲突和重试恢复                   | 草稿保留本地，saveDraft／deleteDraft 不支持                                   |
| 文件夹管理     | 支持创建、重命名、移动、删除文件夹                            | changeLabel 不支持                                                            |
| 永久删除       | 要求 UIDPLUS 或 IMAP4rev2，限定目标 UID 删除并返回部分结果    | checkPermanentDelete／permanentlyDelete 不支持                                |
| SMTP 发送      | 使用 message.from，报告部分收件人拒绝，并可创建 Sent 文件夹   | 使用账户地址作为信封和 MIME 发件人，逐个处理 RCPT 响应，Sent 文件夹必须已存在 |

Node IMAP 的实现分为 `platform/node/imap/{adapter,session,parse,pull,ops,send,recovery,pool}.ts`。Outlook 分为 `outlook/{graph,client,send,sync,parse,pull,recovery,folders}.ts`。旧入口只导出 provider 组装函数；纯函数和传输帮助函数由调用处直接导入所属模块。

T07 的 `CacheStorage` 端口位于 `platform/cache-storage.ts`，Node 实现在 `platform/node/cache-storage.ts`，通过实际数据库路径读取 WAL／恢复文件及 `statfs` 卷空间。portable 默认返回 `disk: null` 与零外部文件字节，手机暂不自动判断低磁盘。SQL 页、消息文本、附件计量仍由 core 提供。`CacheMaintenance` 将 Node 压缩及旧库 rowid 重建放进 `platform/node/cache-worker.mjs`，默认 portable 完整压缩返回 unavailable。迁移共享包装在 db.ts，Node 的 smoke、恢复与测试通过 migrations.ts 使用它。
