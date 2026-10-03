# openmail

本地优先的邮件客户端。桌面界面、CLI 和 MCP 共用 core 与本机 SQLite 数据库。手机端已有 Expo 基础，尚需真机验证。

## 当前功能

- 账户：Gmail、个人 Outlook，以及 iCloud、Yahoo、QQ、163、Fastmail 和自定义 IMAP/SMTP。OAuth 使用用户自己注册的客户端；IMAP 使用应用专用密码或授权码。公司 M365 不在支持范围。
- 同步与整理：增量同步、离线操作队列、旧邮件回填、批量及单封操作、持久撤销记录、稍后提醒、标签与嵌套文件夹、Gmail 分类、服务器过滤器和自动回复。IMAP IDLE 提供新邮件信号，断线时保留轮询。
- 撰写：草稿自动保存与双向同步、富文本／纯文本／Markdown、回复与转发、附件转发、发送并归档、0 至 30 秒撤销发送、附件提醒、模板、命名签名、发件地址选择和联系人补全。支持服务器联系人；macOS 可显式开启 Apple Contacts。
- 阅读与搜索：会话和单封视图、消息文本查找、原始邮件与 EML、打印和 PDF、附件打开与保存、远程图片控制、追踪器拦截。本地全文检索支持布尔、短语、日期、大小等运算符，并可合并服务器搜索；可选本机 OCR、PDF 文本和语义索引。
- 桌面：Profiles 账户分组、通知时段、菜单栏、Dock、原生菜单、拼写检查、多窗口、邮件链接和三套快捷键。包含键盘导航与无障碍回归，界面支持英语、简体中文、捷克语、荷兰语、法语、德语、意大利语、日语、俄语、西班牙语。
- AI：账户授权默认关闭。开启后可用 Anthropic 流式摘要、邮件助手、撰写改写与翻译、收件箱分拣建议。MCP 默认读取；写工具只创建提议，发送须在 app 中确认。授权、数据范围和工具限制见[架构](docs/architecture.md#model-端口)与[代理使用指南](docs/agents.md)。

代码已覆盖这些产品路径。真实账户、系统权限和签名成品的验收范围见[路线图](docs/roadmap.md#待用户完成)。功能对齐的剩余缺口见 [parity](docs/parity.md)。

## 安装、构建与运行

桌面开发和打包目前以 macOS 为目标。使用 Node ≥22.13、pnpm 11.17.0；原生 helper 编译需要 Xcode Command Line Tools。

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

`pnpm build` 构建 core、CLI 和桌面，同时编译手机端语言目录并检查类型。它不生成手机原生应用。`pnpm dev` 启动 Electron 桌面端。

按 [Google](docs/setup-google.md) 或 [Microsoft](docs/setup-microsoft.md) 注册自己的 OAuth 客户端，在 app 的账户引导中填入配置。构建后也可运行 `scripts/setup-oauth.sh` 完成配置与登录。IMAP 账户在 app 中选择预设并填写密码。

打包还需 Xcode 26 编译 Icon Composer 图标。生成本地 macOS arm64／x64 DMG 和 ZIP：

```sh
pnpm --filter @openmail/desktop dist
```

本地包使用 ad-hoc 签名。正式签名、公证、安装包验证和自动更新配置见[发布说明](docs/release.md)。

## CLI 与 MCP

构建后无需全局安装即可调用 CLI：

```sh
node packages/cli/dist/cli.js accounts list
node packages/cli/dist/cli.js sync
node packages/cli/dist/cli.js list --mailbox inbox --unread --json
node packages/cli/dist/cli.js search 'from:alice@example.com has:attachment' --server --json
node packages/cli/dist/cli.js tools --json
```

也可运行 `pnpm --dir packages/cli link --global`，之后使用 `openmail`。MCP 客户端的 stdio 配置如下，`args` 路径须替换为本机仓库绝对路径：

```json
{
  "mcpServers": {
    "openmail": {
      "command": "node",
      "args": ["/absolute/path/to/openmail/packages/cli/dist/cli.js", "mcp"]
    }
  }
}
```

`openmail mcp` 和 `openmail-mcp` 共用工具与权限。CLI 没有发送命令。接入方式、分页、预算、写提议与审批边界只在[代理使用指南](docs/agents.md)维护。

桌面、CLI 和 MCP 默认数据目录为 `~/Library/Application Support/openmail`，可用 `OPENMAIL_HOME` 覆盖。`mail.db` 保存邮件和设置，`config.json` 保存 OAuth 客户端配置；refresh token、IMAP 密码与 AI API 密钥经 core 存入系统钥匙串。手机端使用设备自己的数据库和安全存储，目前没有跨设备本地状态同步。

## 手机端

`apps/mobile` 使用 Expo、React Native 和 `@openmail/core/portable`。已接入 Gmail／个人 Outlook 授权、账户和邮箱列表、分页会话、受限 HTML 阅读、下拉同步，以及十种语言。测试通过 Node SQLite shim 和原生服务 mocks 验证核心路径。

原生 SQLite、Metro 和 OAuth 仍需开发构建实测。当前没有发送界面、IMAP/SMTP、自动轮询、后台刷新或推送。配置、能力限制与后续步骤见[手机端说明](apps/mobile/README.md)。

## 文档与检查

- [领域术语与模块入口](CONTEXT.md)、[架构](docs/architecture.md)、[平台依赖清单](docs/platform-inventory.md)：探索或调整模块时读取。
- [路线图](docs/roadmap.md)、[功能对齐审计](docs/parity.md)：查看进度、验收和剩余范围。
- [测试](docs/testing.md)、[性能](docs/performance.md)：复现自动检查与测量。
- [Apple Contacts](docs/apple-contacts.md)：查看本机通讯录权限、缓存和签名要求。
- [仓库规则](AGENTS.md)：查看网络、数据库、凭证、邮件 HTML 和 MCP 的约束。

```sh
pnpm build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm test
pnpm exec oxlint
pnpm exec oxfmt --check .
```

## 致谢

服务商图标来自 Iconify 图标包。selfh.st 图标使用 CC BY 4.0，见 [selfh.st/icons](https://selfh.st/icons)。
