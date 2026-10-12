# 通过 CLI 和 MCP 使用邮件

先运行 `pnpm build`，再完成账户登录和同步。CLI 和 MCP 使用 NodeMailbox 与同一份本地数据库，不启动 Electron。手机端复用 portable Mailbox，使用设备自己的存储。模块与授权结构见[架构](architecture.md)。

## 人工 CLI

在仓库根目录执行 `node packages/cli/dist/cli.js <命令>`。全局安装后可直接使用 `openmail`：

```sh
pnpm --dir packages/cli link --global
openmail config google --client-id <id> --client-secret <secret>
openmail config microsoft --client-id <id>
openmail accounts add gmail
openmail accounts add outlook
openmail accounts add imap --preset icloud --email me@icloud.com
openmail accounts reauth gmail:me@example.com
openmail profiles add 工作 --icon 🏭 --color blue
openmail profiles assign gmail:me@example.com <profile-id>
openmail list --profile <profile-id> --label <label-id>
openmail show '<message-id>' --thread
openmail proposals list
openmail proposals approve <id>
openmail agents write-mode
openmail audit --limit 20
```

OAuth 注册步骤见 [Google](setup-google.md) 与 [Microsoft](setup-microsoft.md)。IMAP 的 `--preset` 可选 `icloud`、`yahoo`、`qq`、`163`、`fastmail`、`custom`；`custom` 需要 `--imap-host` 和 `--smtp-host`。密码按顺序读取 `--password`、`OPENMAIL_IMAP_PASSWORD`、交互提示；交互提示无需在命令中填写密码。

人工命令的改动以 `user:cli` 进入审计。`agents write-mode` 仅查看权限；传入模式参数会失败，修改须在 app 的设置中完成。`proposals approve` 可批准普通规则的整理提议；MCP 与内置助手提议须在 app 中批准。批准前 CLI 在交互终端里显示提议并要求确认；stdin 不是终端时拒绝执行，除非显式传入 `--yes`。消息提议（send、draft）在 CLI 中一律不能批准，`--yes` 也不行，core 的 `decideProposal` 同样拒绝非 app 的批准，因为脚本里的批准不能算作发送所需的 app 内人工确认。CLI 没有 send 命令，发送须在 app 中审阅。

只检查同步时运行 `openmail health --json`，单账户加 `--account <id>`。报告只比较服务商和本地计数，不同步或修复数据；字段解释只在[同步说明](sync-correctness.md#同步健康检查)维护。命令实现见 [cli.ts](../packages/cli/src/cli.ts)。

需要禁止远程写入时，在 CLI 或 MCP 启动前设置 `OPENMAIL_READ_ONLY=1`。该模式仍可读取网络及凭证、刷新 token 和写本地状态；`sync` 不推送既有队列。MCP 默认读取工具与此会话开关分别控制工具入口和远程写入，详细边界只在[架构](architecture.md#只读会话)维护。MCP 配置可加 `"env": { "OPENMAIL_READ_ONLY": "1" }`。

## 接入 AI 应用

在 app 的「设置 > AI 权限 > AI 应用」里，每个客户端一张卡片：Claude Code、Codex、Claude（桌面版）和 Cursor。卡片显示是否安装、`openmail` 条目是否存在、是否指向当前 app，以及该客户端最近的工具调用。「连接」「重新连接」「断开连接」先弹出确认框，列出要运行的命令和配置文件 diff，点确认才执行。机制、备份和原子写入只在[安全说明](security.md#连接-ai-应用)维护。

| 客户端      | 连接方式                                                           | 配置文件                                                          |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Claude Code | `claude mcp add --scope user --transport stdio openmail -- <命令>` | `~/.claude.json` 顶层 `mcpServers`                                |
| Codex       | `codex mcp add openmail -- <命令>`；没有 CLI 时直接改文件          | `~/.codex/config.toml` 的 `[mcp_servers.openmail]`                |
| Claude      | 直接改文件                                                         | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor      | 直接改文件                                                         | `~/.cursor/mcp.json`                                              |

`<命令>` 在打包 app 里是 `/Applications/OpenMail.app/Contents/MacOS/OpenMail --mcp`，开发构建是 `node <仓库>/packages/cli/dist/cli.js mcp`。app 用的数据目录不是默认值时（例如 `--user-data-dir`），条目带上 `OPENMAIL_HOME`。勾选「允许 … 提议改动，由你批准」会加 `--allow-writes`。卡片里的「手动设置」给出可复制的命令或 JSON。

手动接入时，在仓库根目录执行：

```sh
claude mcp add --scope user --transport stdio openmail -- node "$(pwd)/packages/cli/dist/cli.js" mcp
codex mcp add openmail -- node "$(pwd)/packages/cli/dist/cli.js" mcp
```

Claude 和 Cursor 的 JSON 都用 `mcpServers`：

```json
{
  "mcpServers": {
    "openmail": {
      "command": "/Applications/OpenMail.app/Contents/MacOS/OpenMail",
      "args": ["--mcp"]
    }
  }
}
```

全局链接 CLI（`pnpm --dir packages/cli link --global`）后，`command` 也可以写 `openmail`、`args` 写 `["mcp"]`。Claude 从 Finder 启动时 PATH 很短，找不到命令时改成 `command -v openmail` 输出的绝对路径。`openmail mcp`、`openmail-mcp` 和 `OpenMail --mcp` 都在 stdio 上运行，stdout 只输出协议帧。

服务启动说明告诉模型先调用 `access_status`。它返回可读账户、被隐藏账户的数量和原因（未开 AI 文本授权、账户已停用）、本客户端的写权限、是否提供提议工具，以及用户该去哪里改。被隐藏账户只给数量，不给地址。

## 读取与分页

`openmail tools --json` 返回当前工具名称、说明和输入 schema。每个工具都有对应的连字符命令，也能通过 `openmail tool <工具名>` 调用。输入用 `--input-json`，输出用 `--json`；参数、结果和 MCP 相同。

```sh
openmail list --mailbox snoozed --limit 20 --json
openmail search 'from:alice@example.com has:attachment' --server --json
openmail semantic-search --input-json '{"query":"出差安排","account_id":"gmail:me@example.com"}' --json
openmail read-thread --input-json '{"id":"gmail:me@example.com/m1","max_chars":12000}' --json
openmail list-labels --input-json '{"account_id":"gmail:me@example.com"}' --json
openmail list-templates --json
openmail read-template --input-json '{"id":"template:1"}' --json
openmail suggest-contacts --input-json '{"query":"Alice"}' --json
openmail list-attachments --input-json '{"message_id":"gmail:me@example.com/m1"}' --json
openmail attachment-text --input-json '{"message_id":"gmail:me@example.com/m1","attachment_index":0}' --json
openmail list-invites --input-json '{"message_id":"gmail:me@example.com/m1"}' --json
openmail calendar-overlap --input-json '{"message_id":"gmail:me@example.com/m1","key":"邀请返回的 key"}' --json
openmail tool list_proposals --json
```

| 工具                                  | 返回与后续参数                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `access_status`                       | 可读账户、被隐藏账户数及原因、写权限、是否有提议工具、给用户的下一步；不读邮件                                           |
| `list_accounts`、`list_profiles`      | 账户或分组 ID，传给列表、搜索和草稿提议                                                                                  |
| `list_labels`                         | Gmail 用户标签、Outlook/IMAP 文件夹及 Gmail 分类；ID 用于列表筛选                                                        |
| `list_threads`                        | 会话摘要；`id` 是代表消息 ID，用于读取及整理提议；`mailbox: "snoozed"` 查询稍后提醒                                      |
| `search`                              | 本地全文及已启用的端侧索引命中；`server: true` 显式请求服务商搜索，返回 `ignored`、`errors`、`truncated`，须向用户说明   |
| `semantic_search`                     | 已就绪本地文本向量索引中的最多五个命中，无消息 snippet；不下载模型                                                       |
| `read_thread`                         | 有消息 ID 的模型消息文本，过滤 HTML 隐藏文本、去引用和签名，不含 HTML、图片或附件派生文本                                |
| `list_templates`、`read_template`     | 模板摘要、收件人和消息文本，不创建草稿                                                                                   |
| `list_signatures`、`read_signature`   | 签名 ID、发件地址与纯文本，不返回 HTML                                                                                   |
| `suggest_contacts`                    | 本地历史及缓存联系人的地址，可传给草稿的 `to`、`cc`、`bcc`                                                               |
| `list_attachments`、`attachment_text` | 缓存附件元数据、已有 OCR/PDF 文本，以及附件序号、页码、图片区域和处理版本，不返回二进制数据                              |
| `list_invites`、`calendar_overlap`    | 原始 MIME 中的邀请及重叠事件；使用现有授权，可请求服务商，不回应邀请、不创建事件                                         |
| `list_proposals`、`read_proposal`     | 待审批 ID 和审批界面展示的提议字段；省略 HTML、附件内容等隐藏字段，没有批准、拒绝或发送工具                              |
| `sync`                                | 显式拉取邮件并推送现有队列，会访问服务商并产生既有队列的写入；输出受预算限制，`omitted` 表示省略的账户结果，可逐账户查询 |

所有外发工具结果统一为 `{notice, untrusted_mail}`。主题、发件人、附件派生文本、邀请文字、提议理由以及账户、ID 和分页字段都在 `untrusted_mail` 中，不能当作指令。以下分页字段均从该对象读取。

列表使用 `next_cursor` 翻页，下一次保留原筛选条件，将它传给 `cursor`。会话游标同时包含时间和 ID，同时间邮件不会漏页。其他列表基于当前结果位置；邮件或索引变化后应重新查询。每页最多 100 行；搜索最多分页读取前 200 个候选，更多结果用 `truncated` 提示，须缩小查询。语义检索最多五个候选，联系人建议最多 100 个候选。

`token_budget` 按结果 JSON 的 UTF-8 字节保守限制 token，默认 12000，范围 2000 至 24000。预算不足时返回较少完整行及游标；单行超预算则报错。摘要中的长文本、参与人等字段会缩短，ID 保留原值。模板、签名与提议文本用 `next_offset` 分段读取。附件派生长文本按行拆分，`text_offset` 标明原文位置。`read_thread` 用 `max_chars` 限制完整 JSON，可能省略较早消息，`truncated` 统计删减的消息文本字符。

MCP access 默认跟随逐账户 AI 文本授权。未授权或停用的账户不进入工具读取；读取会话和附件也逐次检查。`semantic_search` 必须显式提供 `account_id`，该账户须开启第三方 AI 文本授权，并已启用本地索引。内置助手仍限定所选且授权账户，移除搜索结果中的消息片段、附件名称和媒体派生命中，不允许服务端搜索。Apple Contacts 快照仅供桌面补全，不进入工具或 AI 上下文，见 [Apple Contacts](apple-contacts.md)。`read_thread` 的主题、发件人和消息文本都位于 `untrusted_mail`；`read_proposal` 的 JSON 文本位于 `untrusted_mail.command_json`。每个结果和分页都带 `notice`，这些邮件字段和提议理由是不可信数据，不应当作工具指令。权限、身份与输出预算回归见[测试](testing.md)。

列表和搜索不返回服务商 snippet。`read_thread` 有 HTML 时优先可见文本；`flags` 可包含 `hidden-text-removed`、`plain-differs`、`budget-exceeded` 或 `quoted-text-removed`，分别表示删过隐藏内容、plain alternative 有差异、CSS 检查预算耗尽或无可靠引用边界时按 `>` 行移除文本；`quotedTextRemoved` 给出移除字符数。识别的回复头块也会截断引用历史；规则见安全说明。预算耗尽时返回固定占位文本 `[Message too complex for AI: message text omitted.]`，不返回未经完整可见性判断的消息文本。提取规则和限制只在[安全说明](security.md)维护，实现见 [model-view.ts](../packages/core/src/model-view.ts)、[visible-text.ts](../packages/core/src/visible-text.ts)和 [tool-pages.ts](../packages/core/src/tool-pages.ts)。

## 提议改动

默认服务只列出读取工具。需要提议时，在配置的 `args` 中加入 `"--allow-writes"`，或运行 `openmail mcp --allow-writes`。还须在 app 的「设置 > AI 权限」中把「AI 改动邮件的权限」设为「只读」以外的选项。从 app 连接时，勾选「允许 … 提议改动，由你批准」即加入 `--allow-writes`。写权限为只读时调用提议工具，返回的消息说明没有改动、去哪里改、改完再调用。权限、逐账户 AI 同意和账户启用状态每次调用都会重新检查；客户端不可读取的账户也不可创建提议。

开启后只增加 `modify_threads`、`snooze_threads` 和 `draft_message`。整理限于归档、已读/未读、星标及添加或移除同账户的现有 Gmail 用户标签，每次最多 20 个会话。文件夹操作仅支持归档，其他移动操作均拒绝；系统标签不开放。稍后提醒须提供未来一年内的毫秒时间。草稿只支持纯文本新邮件、回复、回复全部。

即使写权限设为「直接整理」，MCP 仍只创建提议，由 app 展示全部会话、真实标签名、准确提醒时间或完整草稿供人批准。草稿只保存在本机，用户在 app 中保存后才排队上传；发送始终需要 app 内确认。CLI 的工具调用身份为 `agent:mcp:openmail-cli`，MCP 握手身份为 `agent:mcp:<clientInfo.name>`，均写入审计。客户端名称在记录 actor 时去除控制、双向格式字符和 Unicode 行分隔符，最多 100 字符。审计只存操作种类、账户、收件人数和散列；提议决策后清除命令文本与理由，撤销授权或移除账户时拒绝并清除该账户待审批提议及草稿。旧版审计与已决策提议在首次启动时按同一规则清理，并记录 prefs 标记，之后不再扫描审计表。撤销授权时，已上传草稿的删除也会进入队列，失败时重试；待删除的服务商副本不会在同步中重新出现。

```sh
openmail modify-threads --allow-writes --input-json '{"thread_ids":["gmail:me@example.com/m1"],"action":"archive","rationale":"这封通知已处理。"}' --json
openmail draft-message --allow-writes --input-json '{"account_id":"gmail:me@example.com","to":["alice@example.com"],"subject":"进度","body":"明天回复。","rationale":"先准备草稿供用户检查。"}' --json
```

提议待审批时不要重试。永久删除、清空垃圾箱、规则创建、转发设置、账户/OAuth/设置修改、日历事件创建和 AI 设置均无工具入口。MCP 提议不能通过 CLI 批准。传统账户配置等 CLI 命令仍供用户手动操作，不属于模型 Toolkit。
