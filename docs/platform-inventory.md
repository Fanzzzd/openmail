# core 平台依赖清单

修改 core 平台实现、打包入口或手机 Layer 时读取。导入边界规则在 AGENTS.md，禁止的包名以 `.oxlintrc.json` 为准。`platform-imports.test.ts` 读取该配置，另检查 Node 内置模块和 portable 的本地依赖图。

slice 39 对原有 `packages/core/src` 的审计包括静态、类型、动态导入及 `.mjs` worker。生产 Node 实现现在全部位于 `platform/node/`；进程测试 fixture、fake provider 和 SQLite 内存测试平台也放在此目录。

| 原文件                                                               | 原平台依赖                                                | 处理                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `compose-images.ts`                                                  | dns/promises、http、https、net、crypto                    | 校验和流式限额留在 core；`ImageNetwork` 的 Node adapter 固定解析后的地址，UUID 来自 `PlatformCrypto` |
| `database-access.ts`                                                 | fs、path、sqlite                                          | Node 数据库进程锁 adapter                                                                            |
| `database-recovery.ts`                                               | crypto、fs、path、sqlite                                  | Node 恢复 adapter，通过 `DatabaseFiles` 暴露完整文件操作                                             |
| `recovery-files.ts`                                                  | fs、path、sqlite                                          | Node WAL、恢复文件及锁处理                                                                           |
| `diagnostics.ts`                                                     | crypto、fs、path、sqlite                                  | Node 本地诊断及数据库检查                                                                            |
| `db.ts`                                                              | @effect/sql-sqlite-node、sqlite-vec                       | 迁移、SQL 初始化、能力标签留在 core；连接、扩展加载和锁在 Node adapter                               |
| `embeddings-node.ts`                                                 | path、url、推理进程                                       | Node 模型 adapter，默认 launcher 可由 `InferenceWorker` 替换                                         |
| `inference-process.ts`                                               | child_process                                             | fork adapter；协议及 `InferenceWorker` 在可移植平台端口                                              |
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

Node 专用包包括 `@effect/platform-node`、`@effect/platform-node-shared`、`@effect/sql-sqlite-node`、`@napi-rs/keyring`、`sqlite-vec`、`onnxruntime-node`、`imapflow`、`nodemailer`、`mailparser`、`pdfjs-dist`。当前 Transformers 的模型 worker 也限定在 Node adapter；手机推理使用已有 `ModelRuntime` 替代。`better-sqlite3` 同样在禁止清单，桌面仍使用 `node:sqlite`。

core 的字节操作集中到 `platform/bytes.ts`，Node 选用原生 Buffer，缺少该全局对象时回退到 `buffer/index.js` 的浏览器实现。该模块的 native Buffer 探测由导入守卫检查，边界规则见 AGENTS.md。base64url 明确转换字母表及 padding。TNEF 直接使用 Uint8Array / DataView，共享有界输入；UTF-16LE 手工保留 BOM 和独立代理码元，丢弃末尾单字节，保持原生 Buffer 的解码结果。同步 SHA-256 / HMAC 使用 `@noble/hashes` 的可移植实现，Node 的 `PlatformCrypto` 使用原生加密；随机数服务须由手机安全随机实现提供。

手机端待办以[路线图](roadmap.md#core-平台接口slice-39-已完成)为准。现阶段没有 Expo 项目或 mobile adapter；portable 入口已通过浏览器平台打包。导入检查证明 core 的本地模块边界，不代替 React Native 真机验证、第三方包的 Metro 打包验证或 op-sqlite 的兼容性检查。

MailCodec、PdfWorker、AttachmentFiles、ImageNetwork 是必需的 Effect services，缺少 Layer 会在类型检查中报错。provider、阅读附件和 indexer 构建时捕获依赖，返回的方法不读调用方的隐藏 context。真实 NodeMailbox 回归测试覆盖 IMAP 原始 MIME fallback、正文/日历/嵌套附件、PDF 索引、文件缓存、图片输入和 SSRF 拒绝；仅替换 IMAP 传输和合成密码，使用临时数据库，不启动 Electron。
