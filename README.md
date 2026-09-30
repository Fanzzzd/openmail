# openmail

本地优先的桌面邮件客户端。人用 Electron 界面，模型用 CLI 和 MCP，两边读同一个本地数据库。

## 现状

- Gmail：OAuth 登录，首次同步最近 90 天，之后按 history 增量同步（app 内每 2 分钟一次）。
- 个人 Outlook（outlook.com）：OAuth 登录，按 Graph delta 增量同步各文件夹。
- iCloud、Yahoo、QQ 邮箱、163 邮箱、Fastmail 和任意 IMAP/SMTP 服务器：用应用专用密码或授权码登录。
- 归档、删除、星标、已读、标签和文件夹、写信、回复、转发。改动先写本地，再排队推到服务器，断网时等下次同步。
- 写信：草稿自动保存并和服务器双向同步，发送并归档，可设的撤销发送（0 到 30 秒），作为附件转发，忘带附件提醒，Markdown，模板（⌘/），按发件地址的签名（Gmail 同步，本地优先），按往来邮件补全收件人。
- 阅读：标为已读的时机（立即、1/3/5 秒后、手动），会话归组开关和会话内顺序，原始邮件，打印和存为 PDF，在单独窗口打开会话，每封邮件切换浅色或深色背景，7 档字号（⌘+ ⌘− ⌘0），附件打开、保存和全部保存。
- 搜索与整理（待真实账户验证）：本地 FTS 与三家服务器搜索合并，搜索 token 和文件夹范围；标签和嵌套文件夹管理、显隐、颜色、收藏，⇧⌘G 前往文件夹；持久化稍后提醒；Gmail 和 Outlook 服务器过滤器、自动回复；Gmail 发件别名、签名同步和按账户分类开关。范围和验证清单见 [路线图切片 3](docs/roadmap.md#切片-3-搜索与整理做了什么留了什么)。
- 新增设置 scope 不影响已有账户收发。过滤器、自动回复或 Gmail 别名提示权限不足时，在对应设置页重新登录。
- 远程图片默认拦截，可按发件人或域名总是加载。约 100 个追踪服务的像素和 1×1 远程图片在任何情况下都会拦掉，邮件上显示拦了几个。
- AI 通过 MCP 读邮件。改动邮件默认关闭，在设置的「AI 权限」里打开。AI 写的邮件只能作为建议，由你在 app 里检查后发出。
- 公司 M365 不支持：需要租户管理员授权应用，openmail 不绕过。

## 结构

```
apps/desktop     Electron 44 / electron-vite / React 19 / Tailwind v4 / Effect atoms / Base UI / Lingui
packages/core    Effect v4：Mailbox 服务、provider 适配器、OAuth、SQLite（node:sqlite + FTS5 trigram）、AI 工具
packages/cli     `openmail` CLI 和 `openmail-mcp` MCP server
```

架构和 AI 权限的设计见 [docs/architecture.md](docs/architecture.md)。

数据目录：macOS 在 `~/Library/Application Support/openmail`，可用 `OPENMAIL_HOME` 覆盖。里面有 `mail.db` 和 `config.json`。refresh token 和 IMAP 密码在系统钥匙串，service 名 `openmail`。

## 开发

```sh
pnpm install
pnpm build            # core → cli → desktop
pnpm dev              # 启动桌面 app
pnpm test
pnpm check            # oxlint + oxfmt
```

先按 [docs/setup-google.md](docs/setup-google.md)（Gmail）或 [docs/setup-microsoft.md](docs/setup-microsoft.md)（个人 Outlook）建好各自的 OAuth 客户端。`pnpm build` 之后跑 `scripts/setup-oauth.sh`，向导会逐步打开控制台页面、收集 client ID、存进 config.json 并登录。

## CLI

```sh
openmail config google --client-id <id> --client-secret <secret>
openmail config microsoft --client-id <id>
openmail accounts add gmail
openmail accounts add outlook
openmail accounts add imap --preset icloud --email me@icloud.com   # 提示输入 App 专用密码
openmail accounts reauth gmail:me@example.com
openmail sync
openmail list --mailbox inbox --unread --json
openmail search 报价 1550 --json
openmail profiles add 工作 --icon 🏭 --color blue
openmail profiles assign gmail:me@example.com <profile-id>
openmail list --profile <profile-id> --label <label-id>
openmail show '<message-id>' --thread
openmail proposals list
openmail proposals approve <id>
openmail agents write-mode propose
openmail audit --limit 20
```

CLI 的操作记在审计里，身份是 `user:cli`。CLI 不发信，没有 send 命令。发信要在 app 的审阅窗口里完成。

IMAP 密码按顺序取 `--password`、环境变量 `OPENMAIL_IMAP_PASSWORD`、交互提示。`--preset` 可选 `icloud`、`yahoo`、`qq`、`163`、`fastmail`、`custom`。`custom` 需要 `--imap-host` 和 `--smtp-host`。

`proposals approve` 以你的身份执行模型提议的分拣改动。发信和草稿提议在 CLI 里不能批准，要到 app 里审阅后发送。

本地调用：`node packages/cli/dist/cli.js …`，或在 `packages/cli` 里 `pnpm link --global`。

## MCP

```sh
claude mcp add openmail -- node /abs/path/openmail/packages/cli/dist/mcp.js
```

`openmail mcp` 和 `openmail-mcp` 一样，都在 stdio 上跑。

读取工具：

- `list_accounts`、`list_profiles`、`list_labels`
- `list_threads`：按邮箱、账户、profile、标签、未读筛选会话，用 `before` 翻页
- `search`：全文检索，支持中文
- `read_thread`：整段会话的纯文本，去掉 HTML、引用和签名，按 `max_chars` 截断（默认 12000）
- `sync`：拉取新邮件，推送已批准的改动

写入工具：

- `modify_threads`：归档、移到收件箱、删除、标垃圾、已读/未读、星标、重要、加减标签。每次调用要带 `rationale`，审阅时人能看到。
- `draft_message`：写一封信。它存成一封本地草稿，同时生成一条提议。AI 权限是「只读」时，草稿只在本机，你在写信窗口里保存后才推到邮件服务器；其他模式下 app 下次同步时推送。信不会发出。人在 app 里审阅、修改，再决定发送或丢弃。

写入工具受 app 里「设置 > AI 权限」控制，默认「只读」。只读时调用被拒绝，模型会告诉你去哪里打开。设成「先问我」时改动进入「AI 建议」等你确认。设成「直接整理」时立即生效。CLI 里对应 `openmail agents write-mode off|propose|allow`。无论怎么设，模型都不能直接发信。

审计和提议里记下的身份是 `agent:mcp:<客户端名>`，客户端名取自 MCP 握手里的 `clientInfo`。

## 路线

目标是对齐 Mimestream 的全部功能，之后出手机端。分阶段计划见 [docs/roadmap.md](docs/roadmap.md)。

## 致谢

服务商图标来自 Iconify 图标包。Icons by selfh.st, https://selfh.st/icons（CC BY 4.0）。
