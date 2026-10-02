# Repository Guidelines

`CLAUDE.md` 是这个文件的软链接，只改这里。

## 架构约束

- `packages/core` 是唯一碰网络和数据库的地方。desktop 主进程、CLI、MCP 都只调用 core 导出的函数，不自己写 SQL 或调 provider API。
- 数据库用 `node:sqlite`，不要换成 better-sqlite3。它随 Node 和 Electron 一起发行，app 和 CLI 不需要为不同 ABI 重编原生模块。
- 迁移在 `packages/core/src/db.ts` 的 `MIGRATIONS` 数组里，只追加，不改已有条目。
- `messages_fts` 是外部内容 FTS 表，按 rowid 对齐。写消息只能用 `upsertMessage`（`ON CONFLICT DO UPDATE`），不要用 `INSERT OR REPLACE`，否则 rowid 变化会让索引失配。
- refresh token 只进系统钥匙串（`secrets.ts`），不进数据库和日志。
- 只碰用户名下账户、用用户注册的 client、走官方授权页拿 token。不复用别的 app 的凭证，不借第一方 client ID，不从别的 app 的钥匙串项里读 token。Outlook 只走 `consumers` 租户（个人账户）；公司 M365 需要租户管理员授权应用，不绕过。
- 邮件 HTML 是不可信内容。渲染层的 iframe 必须保持 `sandbox` 不含 `allow-scripts`，远程资源默认由 iframe 内的 CSP 拦截。
- MCP 工具默认只读。新增会改动邮件的工具时，要有显式开关，发送必须经过 app 内人工确认。

## Electron

- 主进程入口是 ESM。不要在顶层 `await app.whenReady()`：Electron 要等入口模块求值结束才发 `ready`，会死锁。用 `app.once("ready", …)`。
- preload 开了 sandbox，必须输出 CJS（见 `electron.vite.config.ts`）。
- electron-vite 5 只支持 vite ≤ 7。

## 检查

提交前跑：

```sh
pnpm build && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .
```

lint 用 plany 同一套 oxlint 配置，type-aware。`no-unsafe-type-assertion` 的警告只允许出现在 IO 边界（SQLite 行、HTTP JSON）。

界面文案用 Lingui，代码里写英文原文，翻译在 `apps/desktop/src/renderer/src/locales/{locale}/messages.po`。新增文案后跑 `pnpm --filter @openmail/desktop i18n:extract`，补齐 zh-CN、cs、nl、fr、de、it、ja、ru、es 的全部 `msgstr`，保留 ICU 参数、复数和组件标记。用 `pnpm --filter @openmail/desktop i18n:missing` 列出各语言漏译。`pnpm test` 会检查目录同步、每个目录的翻译完整性及参数；任何语言漏译都会失败。

翻译邮件术语时读取 `apps/desktop/src/renderer/src/locales/glossary.json`；正文用“消息文本”的表达，引用按钮时插入该按钮的翻译值，并注明 Lingui context/comment。新增语言文案须通过术语一致性和严格 ICU 解析测试；日语复数只用 `other`，数值分支仍可保留。

## Agent skills

### Issue tracker

Issues live in GitHub Issues of the private repo `Fanzzzd/openmail`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
