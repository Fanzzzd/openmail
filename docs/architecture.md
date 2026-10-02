# 架构

openmail 是 AI 优先的邮件客户端。人和模型用同一套接口读写邮件，区别只在权限。这份文档定模块怎么切、接口放在哪、哪些规则只写一次。术语按 codebase-design 的用法：模块（module）、接口（interface）、接缝（seam）、适配器（adapter）。

## 现状的问题

`@openmail/core` 导出四十多个函数。desktop 主进程、CLI、MCP 各自拼调用顺序：先 `threadMessageIds` 展开会话，再 `modifyMessages`，自己传 actor，自己决定要不要 flush。三个调用方各有一份这类逻辑。

AI 写权限如果也这样散着放，每加一个入口（手机、自动化规则、第二个 MCP 客户端）就要重写一遍检查，漏一处就是模型绕过了人工确认。

provider 同步代码直接写库（`upsertMessage`、`saveSyncCursor`），所以整条写入链路离不开钥匙串和网络，`modifyMessages` 没法在测试里跑。

## 目标结构

```
 desktop 主进程   CLI   MCP server   手机 app   自动化规则
        \          |        |          /           /
         └──────────────  Mailbox  ───────────────┘      ← 唯一的外部接口
                 │        │         │         │
              Policy   Pipeline   Query    Context
                          │                   │
                    Provider 端口          Model 端口
                 gmail outlook imap fake   anthropic / 本地 / fake
                          │
                   Platform 端口（sqlite、钥匙串、OAuth 回调）
                 node+electron 一套，expo 一套，内存一套
```

### Mailbox：唯一的外部接口

所有调用方只拿到一个对象：

```ts
const mailbox = openMailbox({ platform, providers, model, clock });

mailbox.query(q)                 // 列表、筛选、搜索合成一个入口，返回分页的会话
mailbox.thread(id, view)         // view: "ui" 给界面，"model" 给模型（见 Context）
mailbox.do(command, actor)       // 所有改动：分拣、发送、草稿、账户操作
mailbox.undo(outcomeId, actor)
mailbox.sync(accountId?)
mailbox.subscribe(listener)      // 同步进度、队列状态、待确认的 AI 建议
```

`do` 返回三种结果之一：`applied`（已执行）、`proposed`（进了待确认队列）、`denied`（策略拒绝，附原因）。调用方不用知道会话展开、本地先改、排队、审计这些步骤。它们全在 Mailbox 里面。

删除测试：删掉 Mailbox，会话展开、策略检查、审计会回到每个调用方里各写一份。所以这层有存在的价值。

### Command 和 Actor

改动一律是可序列化的 `Command` 值：

```ts
type Command =
  | { kind: "modify"; threads: string[]; op: MailOp }
  | {
      kind: "send";
      accountId: string;
      message: OutgoingMessage;
      draftId?: string;
      archive?: boolean;
    }
  | { kind: "draft"; accountId: string; message: OutgoingMessage } // 只有模型用，见「草稿」
  | { kind: "removeAccount"; accountId: string };

type Actor =
  | { kind: "user"; surface: "app" | "cli" }
  | { kind: "agent"; surface: "mcp" | "rule"; name: string; rationale?: string };
```

Command 是值，所以同一个东西能直接放进待确认队列、审计日志和撤销栈，不需要三种格式。模型给出的理由（`rationale`）随 Command 一起存，人确认时能看到模型为什么要这么做。

### Policy：权限只在一处判断

```
               read  modify  draft  send       removeAccount
user            ✓      ✓       ✓     ✓(撤销窗口)   ✓
agent 默认      ✓      ✗       ✗     propose     ✗
agent 开启写    ✓    ✓/propose  ✓    propose     ✗
```

- 模型发信永远是 `propose`，配置改不掉。这是 AGENTS.md「发送必须经过 app 内人工确认」的落点，写在 Policy 里，调用方拿不到绕过它的入口。
- 分拣写权限按 agent 名字开关。规则保留「直接执行」或「先建议」；MCP 的额外限制见[代理使用指南](agents.md)。
- 策略数据存在库里，不存在 MCP 进程参数里。app 里改开关，CLI 和 MCP 下次调用就生效。

待确认的建议进 `proposals` 表。app 里有一个「AI 建议」视图，逐条或批量确认。确认后以 user 身份执行，审计里同时记下提议的 agent 和确认的人。

### Pipeline：改动的固定顺序

```
do(command, actor)
  → Policy.check           denied / proposed 在这里返回
  → 展开会话为消息
  → 本地应用（按 provider 的标签或文件夹模型）
  → 写 pending_ops
  → 写 audit_log
  → 推送（Provider.push），失败留在队列里重试，授权失败标记账户需重新登录
  → 返回 applied，带 outcomeId 供撤销
```

这些现在分散在 `actions.ts` 和 `store.ts`，已经是这个顺序，下一步只是收进 Mailbox，去掉对外导出的中间函数。

### Provider 端口

```ts
interface Provider {
  connect(input): Promise<Credentials>;
  pull(account, cursor): AsyncIterable<Change>; // Change = upsert | delete | labels | cursor
  push(account, providerId, op): Promise<void>;
  send(account, message, threading): Promise<void>;
}
```

和现在的区别：`pull` 只产出变更，不写库，由 Mailbox 统一落库。这样：

- 写库的只有一个模块，FTS 对齐、事务边界、`upsertMessage` 规则只在一处成立。
- 有 fake provider（内存里的一组邮件和操作日志）后，整条 `do → push → pull` 能在测试里跑，不碰网络和钥匙串。

gmail、outlook、imap、fake 四个适配器，这是真实的接缝。

### 草稿

草稿单独一张 `drafts` 表，不放进 `messages`。理由：

- `messages` 是 provider 的镜像，主键是 provider 给的 id。草稿在推到服务器之前没有这个 id，离线写的草稿也要能存。
- 草稿要存 `messages` 没有的东西：密送、附件内容、Markdown 开关、作为附件转发的标记。
- 同步会整行覆盖 `messages`。编辑中的草稿如果也在这张表里，一次拉取就会冲掉没推上去的改动。

一条草稿由本地 id（`draft:<uuid>`）标识，app 自己生成，所以自动保存多少次都是同一条。服务器上的副本记在 `remote_draft_id`（Gmail 的 draft id）和 `remote_message_id`（三家都有的 message id）。拉取回来的服务器副本照常进 `messages`（标签 DRAFT），靠 `remote_message_id` 和本地草稿对上。「草稿」列表是两者的并集：`messages` 里的草稿，加上服务器还没有副本的本地草稿。读会话时，每封草稿副本带上它对应的本地草稿 id（`Message.draftId`），阅读区按这个 id 打开草稿。Gmail 和 IMAP 每次保存都换 message id，本地 id 不变。

写入顺序和其他改动一样，先本地，再排队：

```
saveDraft(draft)
  → 写 drafts（本地立即可见）
  → pending_ops 里放一条 saveDraft（同一草稿只留一条，推送时读最新内容）
  → 后台 flush：prepare（渲染 Markdown、取原邮件做 .eml）→ Provider.saveDraft → 记下服务器 id
```

- Gmail 用 `users.drafts` create / update / delete，每次保存 message id 会变，旧的本地副本当场删掉。Outlook 的草稿是 Drafts 文件夹里的邮件，原地 PATCH，回复用 `createReply` 建，这样会话能对上。IMAP 用 APPEND 放进 Drafts 文件夹，带 `\Draft` 标记，再删掉旧的那封；服务器没有 UIDPLUS 时按 Message-ID 找回新的 UID。
- 发送已保存的草稿走普通发送路径，发完删本地草稿，再排队删服务器副本。三家共用一条发送路径，离线写的草稿联网后照样能发。没有用 Gmail `drafts.send` 和 Graph `/send`。
- 丢弃：删本地草稿，排队删服务器副本。
- 别的客户端删了或发出了草稿：拉取时对应的 message 被删除，或者去掉了 DRAFT 标签，本地草稿跟着删，前提是它没有待推送的改动。本地有未推送的改动时，本地版本优先，推送时如果服务器副本已经没了就重建。
- 别的客户端新建的草稿：在列表里打开时，core 用 `Provider.fetchRaw` 取原始 MIME，解析出密送和附件内容，存成本地草稿。离线且没有附件时用 `messages` 里的内容。
- 换发件账户：旧账户上的副本排队删除，新账户上重新建。

队列现在由 app、CLI、MCP 三个进程共用。`pending_ops.claimed_at` 记录谁在推送哪一条，两分钟内的认领算有效，所以同一条草稿不会被两个进程各建一份。

模型写的草稿走 `perform({ kind: "draft" })`。策略给出 `proposed` 后，core 建一条带 `proposal_id` 的本地草稿。MCP 草稿的权限与上传时机见[代理使用指南](agents.md)。人在写信窗口里打开它，发出去就批准提议，丢弃就拒绝提议。模型的进程不推送，也没有任何入口能发信。

撰写相关的偏好、签名、模板、联系人黑名单都在 core 的表里（`prefs`、`signatures`、`templates`、`hidden_contacts`），CLI 和以后的手机端读同一份。签名按发件地址和「新邮件 / 回复」区分，`source` 列留给以后同步的 Gmail 签名。收件人补全目前只查本地往来邮件，`Mailbox.suggestContacts` 是以后接入服务器联系人的地方。

### 阅读

原始邮件、附件内容、内嵌图片都经 Mailbox 从 provider 现取，不存进库：`rawMessage`、`attachment(messageId, index)`、`inlineImages`。适配器为此各有 `fetchRaw` 和 `fetchAttachment`，附件按文件名和同名序号定位。保存、打开、打印这些碰文件和窗口的事在 desktop 主进程做，内容仍来自 core。

处理邮件 HTML 的规则在 core 里，不依赖 Node，经 `@openmail/core/schema` 给渲染进程和以后的手机端用：`trackers.ts` 是追踪服务清单，`reader-html.ts` 删掉追踪地址并替换 `cid:`，`print.ts` 拼打印用的文档，`reading.ts` 放标为已读的计时、远程图片白名单的匹配和会话排序。远程图片白名单存在 `image_senders` 表。

### Platform 端口：给手机留的接缝

core 里直接依赖运行时的只有三处：`node:sqlite`、`@napi-rs/keyring`、本地回环 OAuth 回调。收成一个端口：

```ts
interface Platform {
  db: SqlDriver; // node:sqlite / expo-sqlite / 内存
  secrets: SecretStore; // 系统钥匙串 / expo-secure-store / 内存
  authorize(req): Promise<TokenResponse>; // 回环端口 / 系统浏览器 + app scheme
}
```

SQL、迁移、同步逻辑、策略全部复用。手机端只写这三个适配器。现在只有 node 一个真实适配器加测试用的内存版，够格做接缝。

### Query 和 Context：给界面的视图和给模型的视图

同一个会话给人看和给模型看，需要的形状不同。界面要 HTML、附件、头像。模型要纯文本，去掉引用的历史和签名，控制 token 预算，保留可引用的 id。

`mailbox.thread(id, "model")` 负责后者，MCP、自动化规则、以后的内置助手都走它，不再各自截断正文（现在 MCP 里的 `forModel` 挪进来）。

检索分两层：

1. FTS5 trigram 全文检索（已有）。
2. 语义检索：派生表存 embedding，查询时和 FTS 结果合并排序。embedding 模型走 Model 端口。

### 派生数据：模型的产出单独存

摘要、分类、待办、embedding 都是派生数据，存在 `derived` 表，当前摘要按 `(thread_id, kind)` 主键，账户通过外键关联。每行带模型名、提示词版本、输入哈希。

- 不覆盖 provider 的数据。同步改了邮件，输入哈希变了，派生行作废重算。
- 换模型或改提示词只需按版本批量重算。
- 模型结论能追溯来源，界面可以标出「这条摘要由哪个模型生成」。

### Model 端口

```ts
interface Model {
  stream(req: ModelRequest): Stream<ModelOutput, InvalidInput | ProviderError>;
}
```

实现见 `model.ts`：`Model` Effect service、`ModelAnthropic` Layer 和 `FakeModelLayer`。Anthropic 使用 pinned `effect/ai` 的 `LanguageModel` 与 Messages API，默认 `claude-sonnet-5-5`，可选 `claude-opus-5-5`、`claude-haiku-4-5-20251001`。端侧 embedding 仍由现有 `ModelRuntime` 提供，语义检索复用本机索引。

第三方 AI 的设置、隐私与执行边界统一在 `mailbox-ai.ts`：

- 迁移 26 紧接 slice 29 的真实迁移 25，新增 `ai_accounts`、`ai_config`、`derived`。新旧账户发送文本和自动摘要默认关闭，密钥只经 `secrets.ts` 存系统钥匙串；渲染层只查询是否已保存，提交不经过 mutation atom。
- `thread(id, "model", tokenBudget)` 和 MCP 的 `threadForModel` 共用 `modelContext`：纯文本、去引用和标准签名、保留消息 id，以 UTF-8 字节保守限制 token。图片、附件内容与端侧媒体派生内容不进入第三方模型上下文。邮件以转义 JSON 数据标记包裹，工具权限由代码固定。
- 摘要按 `(thread_id, kind)` 存模型名、提示词版本、完整文本上下文哈希。读取时验证哈希、模型和提示词版本；正文更新和删除也清理派生行。缓存不覆盖 provider 数据。账户撤销授权时，事务内清理该账户全部 AI 派生行；提示词版本 v2 使旧版无法区分完整与截断的缓存失效。
- 单次请求最多 24,000 输入预算、1,024 输出 token、4 轮、12 次工具调用，60 秒总超时。输出预算跨轮共享。取消、移除密钥或调整账户授权会中断请求，半截摘要不缓存。Model 端口保留结束原因，达到 token 上限的文本显示为截断且不缓存。自动摘要仅处理明确开启账户的新邮件，每批最多三个，顺序运行且不重试。
- Cmd-J 助手使用 `MailToolkit` 的七个工具子集：账户、标签、搜索、本地语义检索、会话读取、整理提议、草稿提议。读取限定本次选中且授权的账户，移除媒体搜索命中；语义排序仍在本机完成。账户工具只返回 id、provider、email、needsReauth。`Policy` 强制内置助手只提议归档、标签和草稿，确认只接受 app。标签提议限定为添加所属账户的 Gmail 用户标签，排除系统标签与特殊文件夹，拒绝 Outlook/IMAP 标签移动。审批展示真实标签名及草稿的 From、To、Cc、Bcc、模式、原邮件主题和完整可滚动正文。草稿先留本地，人在撰写窗口编辑和发送。MCP 默认权限不变。

slice 34 扩展同一 Model 服务。撰写的 ⇧⌘J 和工具栏支持指令写信、选区或全文改写、语气预设及翻译。输出先展示文本差异，接受后由现有 compose 转义与清洗路径写入，丢弃不改草稿，撤销仅在内容仍与接受结果一致时恢复原内容，后续输入会清除撤销入口。Model 按用途使用固定系统提示词，撰写没有工具，也不接收或修改收件人。

自动分拣另设逐账户开关，默认关闭，与摘要独立。新收件箱会话最多每批三个、每账户每分钟一批，顺序处理，复用输入和输出预算及总超时。桌面仅在前台或接电时允许执行，条件消失会中断流；授权和密钥变化沿用请求取消。建议按 `triage` 存入派生表，携带模型、提示词版本、输入哈希及 pending / accepted / dismissed 状态；分拣输入哈希包括逐封消息的标签或文件夹集合，缓存和确认均重验输入；确认时须仍在收件箱且会话不含垃圾箱、垃圾邮件或草稿，否则删除建议并拒绝执行。建议只在收件箱显示，忽略后不重复生成。归档、Gmail 用户标签、稍后提醒及需要回复都须用户确认，经现有 Mailbox 用户操作执行；需要回复以星标保存。助手新增只读 `semantic_search`，仅查已就绪本地文本向量，不下载模型，账户范围与摘要授权一致，片段、附件名称和媒体派生命中按 slice 31 规则清空。

迁移 29 紧接 main 的真实迁移 28，只新增 `auto_triage`；没有占位，已有迁移未改。

设置页说明发送的数据和 API 费用；阅读区摘要与助手回答显示模型及可打开的来源消息。协议与边界用 fake fetch、fake Model Layer、fake providers、内存和临时磁盘库测试。

## 用 Effect v4 实现

core、CLI、MCP 全部用 Effect v4（`effect@4.0.0-rc.118`，版本锁死，正式版发布后再升级）。上面的每个端口直接对应一个 Effect service，每个适配器对应一个 Layer：

| 概念          | 代码                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 领域类型      | `domain.ts` 里的 `Schema`。SQLite 行、provider JSON、IPC 参数、MCP 工具参数都用它解码                                                    |
| 错误          | `errors.ts` 里的 `Schema.TaggedError`：`AuthError`、`PermanentError`、`ProviderError`、`ClientNotConfigured`、`NotFound`、`InvalidInput` |
| Mailbox       | `mailbox.ts`，唯一对外的 service                                                                                                         |
| Store         | `services.ts` 的 `Store`，唯一跑 SQL 的地方，底层 `effect/sql` + `@effect/sql-sqlite-node`（内部是 `node:sqlite`）                       |
| Provider 端口 | `ProviderAdapter`：`pull` 返回 `Stream<Change>`，不写库                                                                                  |
| Platform 端口 | `Secrets`、`AppConfig`、`OAuth`、`Browser` 四个 service；node 一套 Layer，内存一套 Layer                                                 |
| 模型工具      | `tools.ts` 的 `Toolkit`（`effect/ai`）。MCP server 用 `McpServer.toolkit` 暴露它，app 内置助手用 `LanguageModel` 调它，工具只定义一次    |
| CLI           | `effect/cli`                                                                                                                             |

手机端用 `@effect/sql-sqlite-react-native` 和 expo 的钥匙串实现同一组 service，Mailbox 以上的代码不变。

错误跨 RPC 时保留 tag，渲染层按类型给出中文提示，不再拼字符串。

失败分两类。`AuthError` 这类调用方要处理的失败走错误通道。SQL 错误、解码失败算缺陷（defect），说明有 bug 或文件损坏，调用方不处理。

## 迁移顺序

每一步都能单独提交，旧接口在最后一步前保持可用。

1. Policy 和 proposals 表进 core。（已完成）
2. core 改写成 Effect：Mailbox、Store、Provider 端口、Platform 端口、fake provider 和端到端测试一起落地。desktop、CLI、MCP 改用 Mailbox。（本轮）
3. Context、派生数据、Model 端口、内置助手与逐账户自动摘要已完成（slice 31）；自动分拣仍待实现。
4. 手机端：React Native 的 Platform Layer。
