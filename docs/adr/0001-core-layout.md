# 0001 core 按领域分目录

状态：已采纳。

## 背景

`packages/core/src` 顶层有约 320 个文件，只有 `outlook/` 和 `platform/` 两个子目录。新贡献者只能靠文件名前缀找代码。madge 在 core 中找到 15 个导入环，在桌面源码中找到 12 个，全部经由 `import type`，所以 oxlint 已有的 `import/no-cycle`（默认忽略类型导入）没有拦下。`tools.ts`、`db.ts`、`gmail.ts`、`search.ts`、`domain.ts`、`services.ts` 等文件超过 1000 行。

## 决定

core 的源文件按 [CONTEXT.md](../../CONTEXT.md) 的领域分目录。目录名用术语表里已有的名字，文件保留原名，git 历史和现有文档里的文件名仍可搜索。

| 目录                 | 内容                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| 根目录               | 只放包入口：`index.ts`、`common.ts`、`portable.ts`、`schema.ts`           |
| `domain/`            | 领域 schema、错误类型、MailOp 与文件夹范围、分类、整理规则                |
| `mailbox/`           | Mailbox 服务与 `mailbox-*.ts` 子模块、策略、只读会话、撤销记录、发件箱    |
| `store/`             | Store 端口与 `store-*.ts` 查询、行解码                                    |
| `db/`                | 追加迁移、迁移执行、搜索标志位 SQL、数据库能力                            |
| `sync/`              | 同步健康报告、同步重置、失败分类、邮件头回填、token 保活、退避            |
| `providers/`         | ProviderAdapter 端口、HTTP、重试、诊断、可选服务、OAuth client 与重新授权 |
| `providers/gmail/`   | Gmail 适配器，按拉取、history、发送、标签拆分                             |
| `providers/outlook/` | Outlook 适配器（原 `outlook/` 与 `outlook-*.ts`）、Graph 分页             |
| `providers/imap/`    | 两端共用的 IMAP 游标、预设、IDLE 调度；协议实现仍在 `platform/`           |
| `calendar/`          | 日历事件、时间与重复规则、邀请解析、Windows 时区表、服务商日历            |
| `contacts/`          | 联系人与 Apple Contacts 快照                                              |
| `compose/`           | 撰写正文、格式、Markdown 草稿、签名、收件人                               |
| `mime/`              | MIME 解析、TNEF、附件策略与阅读附件、Message-ID                           |
| `reader/`            | 阅读 HTML 清洗、跟踪器、链接与发件人安全、打印、阅读规则                  |
| `visible-text/`      | 模型消息文本的可见文本提取                                                |
| `search/`            | 查询解析、FTS、bigram、排名、片段与高亮                                   |
| `ai/`                | Model、ModelRuntime、本机索引、向量检索、模型消息视图                     |
| `tools/`             | MailToolkit，每组工具一个模块，`tool-pages.ts` 处理分页与预算             |
| `app/`               | 桌面集成：链接与通知判断、更新、远程访问、反馈                            |
| `platform/`          | 平台端口；`platform/node/` 和 `platform/react-native/` 不变               |

规则：

- Node 专用代码仍只在 `platform/node/`。`platform-imports.test.ts` 遍历整个 `src`，新目录自动纳入检查。
- 包的导出路径不变。`package.json` 的 `exports` 只改指向的 dist 文件。desktop、CLI、mobile 的生产代码只经入口导入 core，测试里的深路径随文件移动更新。
- 测试与被测源文件放在同一目录。覆盖多个模块的集成测试放在它主要验证的领域目录，Node 进程测试放在 `platform/node/`。
- 拆分大文件按接口边界，不按行数切。拆出的模块由调用方直接导入，不留重导出旧路径的兼容文件。
- 目标是非生成源文件不超过约 800 行。`db/migrations.ts` 例外：`MIGRATIONS` 是只追加的 SQL 数据，拆开会让“追加在末尾”这条规则变得含糊。

## 导入环

共享类型下沉到叶子模块，打断所有环。门禁用 oxlint 的 `import/no-cycle` 并设 `ignoreTypes: false`，类型导入构成的环同样报错。全仓库检查约 1 秒，`pnpm exec oxlint` 已在提交前检查里，不新增依赖。

## 后果

- 新文件要放进对应领域目录。顶层只允许入口文件，`platform-imports.test.ts` 检查这一点。
- 文档里的源码路径要带目录。
- 一次性移动会让未合并分支产生冲突。当前只有这一个分支在改代码，冲突成本低。
