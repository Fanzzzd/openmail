# 邮件语料检查

`corpus-check` 对本地缓存副本逐封运行邮件处理代码，输出汇总诊断或单封结构诊断。无需 Electron、登录、网络、钥匙串或模型。

```sh
pnpm build
pnpm cli corpus-check --db /path/to/mailbox-copy.db
pnpm cli corpus-check --db /path/to/mailbox-copy.db --limit 1000 --json > /tmp/corpus-report.json
```

`--db` 必填。只处理 `body_cached=1` 的邮件，按日期倒序、相同日期按 ID 排序。`--limit` 默认全部，0 只检查数据库是否可读。输出不含数据库路径、主题、姓名、地址、消息文本、URL、文件名或原始邮件头。

## 单封结构诊断与运行密钥

需要后续定位单封时，用 `--explain-ready` 扫描。密钥保存到报告之外的 0600 文件，文件路径仅写入 stderr；JSON 和文本报告均不含密钥或路径：

```sh
pnpm cli corpus-check --db /path/to/mailbox-copy.db --explain-ready --json > /tmp/corpus-report.json
# HASH 取自报告 samples；RUN_KEY 填 stderr 中的 Run key file 路径。
HASH='在此填入样本的 hash'
RUN_KEY='/path/from/stderr/run.key'
pnpm cli corpus-check --db /path/to/mailbox-copy.db --explain "$HASH" --run-key "$RUN_KEY" --json
# 使用同一份缓存副本和密钥重跑汇总，比较相同消息：
pnpm cli corpus-check --db /path/to/mailbox-copy.db --run-key "$RUN_KEY" --json
```

`--explain` 接受 64 位 hex 哈希，必须同时提供 `--run-key`，不能与 `--limit` 或 `--explain-ready` 合用；找不到哈希时返回固定错误，不回退到另一封。`--run-key` 可复用现有 0600 普通文件；汇总模式也可指定尚不存在的文件路径以创建密钥。拒绝符号链接、非 0600 权限、错误长度或内容。普通扫描不指定这两个选项时，随机密钥仅保留在内存，结束后无法用该报告定位单封。

样本 `hash = HMAC-SHA256(key=32 字节随机密钥, data=UTF-8 十进制 messages.rowid)`。哈希不再基于消息 ID；报告版本为 2，旧版 `--salt` 报告不能直接复用。定位时必须保留同一份缓存副本，重建数据库可能改变 rowid。密钥文件不会随扫描结束删除；完成诊断后自行删除，需要分享时只分享报告。报告仍是敏感诊断材料，不保证匿名化。

单封模式只解析选中的缓存行，复用相同的只读副本、MIME 解码、清洗、可见文本路径和 worker 限额。输出为 JSON，省略 `--json` 时也用 JSON；没有消息文本、class／ID 名、属性值、CSS 声明值、URL、文件名或原始堆栈。

- `mode=explain`，`sample` 沿用哈希、provider、大小桶和 MIME 结构。
- `status` 为 `complete`、`failed`、`timeout`、`aborted` 或 `size-limit`。失败只带固定异常类、阶段和代码入口；诊断未完成时 `diagnostics=null`。
- `textPlainNonEmpty` 表示缓存的 `body_text` 去空白后非空；`decodedTextPlainNonEmpty` 表示重解码后的状态。缓存不保存原始 MIME part 来源，不能由这两个字段证明原始 text/plain part 存在。
- `cachedHtml` 是原缓存 HTML 的结构。`original` 从重解码 HTML 开始，`sanitized` 从 reader-sanitize 阶段输出开始；两者的可见文本均最终经过阅读器清洗、参考 shell 和 HTML5 解析。两者差异检查重复清洗的稳定性，不是未清洗文本与阅读器文本的比较。
- `structure` 包含元素总数、固定 HTML 标签计数、文本节点数及字符数、注释与 MSO 条件注释数、最大深度、head 内的文本数量、body 是否位于 head 内、style 块和内联 style 属性数。自定义标签统一计入 `other`。
- `stylesheetSelectorShapes` 仅计选择器类型和白名单语法，如 `class-selector`、`id-selector`、`attribute-selector`、`:not`、`:has`、组合器和 `@media`。未知伪类仅计 `pseudo-class`，未知 at-rule 计 `@other`；解析失败仅计数。
- `removedByRule` 是实际过滤分支丢弃的文本节点数和字符数，覆盖 hidden／aria-hidden、display:none、visibility、opacity、零／极小字体、近似同色、负偏移、缩放、zoom、content-visibility、未能确定的 CSS、裁剪、filter opacity、绘制不确定、定位遮挡和 OMIT 标签。`removedBySource` 按 HTML 属性、内联样式、stylesheet 规则、继承值、OMIT、注释汇总同一批移除。两组是不同维度，不能相加。
- 每个被剪掉的 DOM 子树只统计一次，归因于第一个触发的规则；被祖先剪掉后不继续给后代规则计数。font-size／visibility 则在文本叶节点上按有效继承值计数，允许后代覆盖；规则见[邮件内容保护](security.md#mail-content-protection)。MSO／普通注释不生成 DOM 文本节点，单独解析其惰性内容并统计潜在文本节点与字符，计入对应注释类别。这部分不能与实际 DOM 节点总数直接比较。
- 字符数采用 UTF-16 code unit，包含空白和 OMIT 标签中的 style／script 文本。`retainedTextNodes`、`retainedCharacters` 是保留节点的原始计数；`visibleCharacters` 是空白规范化后的文本长度。规范化消耗的空白不归入隐藏规则。
- `budgetExceeded`、`cssRuleBudgetHits`、`nestingDepthLimitHits` 来自实际可见性检查。结构和选择器统计不执行浏览器布局，不读取外部 CSS。

## 输入与只读边界

扫描始终先将 DB 和现有 WAL 复制到权限为 0700 的临时目录，文件权限为 0600；不复制配置、钥匙串或附件文件，不打开源库的 SQLite 连接，也不创建源库的 SHM 或锁文件。复制前后比对文件身份、大小、修改时间和状态变更时间；源文件变化时最多重试三次，仍变化则拒绝扫描。持续写入的库须先由用户取得稳定副本。副本以 `DatabaseSync({ readOnly: true, allowExtension: false })` 打开，并检查 `query_only=ON`；不运行迁移、回填或缓存维护。结束、异常或取消后删除临时目录。

普通 OpenMail 缓存只保存解码后的消息文本，没有原始 MIME 或完整 MIME 树。`mimeSource=reconstructed-cached-utf8` 表示将缓存文本重建为 UTF-8 MIME，经过 `normalizeMimeCharsets`、Node MailCodec 和 `compatibleMime`，再用 `withDecodedBody` 生成文本。它可以发现缓存内容触发的兼容解析问题，不能重现原始传输编码、丢失的字符或签名附件解包问题。字符替换诊断统计缓存及重解码输出中现存的 U+FFFD，不证明错误发生在哪次解码。

## 报告字段

- `version`：报告格式版本，当前为 2。密钥及其文件路径不属于报告字段。
- `processed`：取出的缓存行数，含失败、超时和大小上限跳过的行。
- `source`：固定为 `temporary-read-only-snapshot`。
- `limits`：消息处理期限默认 2000 ms，worker 启动期限 15000 ms，单封缓存字段总字节上限 16 MiB，worker 老生代堆上限 96 MiB，每种异常及每阶段失败分类最多保留 5 个样本。
- `stages`：各阶段的 `count` 为开始次数，`completed` 为返回次数，`failures` 按固定异常类和代码入口汇总。代码入口是调用位置，不是原始堆栈或根因行号。超时归入最后开始但未完成的阶段。缓存解析失败后的阶段不会执行；大小上限跳过的行没有阶段计时。
- `timeMs`：p50、p95 为固定对数直方图估计的上界，误差最多为实值的 5% 加 0.00005 ms；max 是实际最大值。包含失败和超时耗时，不含复制、读行、worker 启动及消息传递成本。总处理期限覆盖所有阶段，独立主线程计时器可终止同步解析。
- `anomalies`：顶层按异常汇总计数和样本；阶段内仅有计数。同一邮件在不同阶段触发同类异常会分别计数。链接及事件计数按发现的数量，其余按阶段观察次数。样本按扫描顺序取前五个不同消息。

每个样本仅有 `hash`、固定枚举 `provider`、`sizeBucket` 和 `contentTypeStructure`。大小优先使用 provider 缓存的消息大小，缺失时使用缓存字段字节数。结构只允许固定 MIME 类型，未知类型写为 `other`，参数全部丢弃；最多列出 16 个附件类型。这是由顶层 Content-Type、缓存文本和附件元数据推导的结构，不是完整原始 MIME 树。缓存解析未完成时结构为 `other[]`。超限行也可通过 rowid 哈希保留样本，无需读取完整消息 ID。

## 阶段与异常

| 阶段               | 执行路径                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| cache-decode       | Schema 校验 SQLite 缓存行，不输出解析错误详情                                                  |
| mime-decode        | 重建 MIME、mime-compat、Node MailCodec、withDecodedBody                                        |
| reader-sanitize    | prepareMessageHtml 后运行 sanitizeReaderHtml，远程资源关闭                                     |
| visible-text       | 原 HTML 与阅读器清洗后 HTML 的 visibleHtmlText                                                 |
| model-text         | modelContext，包括隐藏文本过滤、引用裁剪及上下文字节预算                                       |
| link-security      | 同一可见文本遍历收集清洗后链接标签，linkDisplayMismatch                                        |
| message-security   | 缓存 Authentication-Results 及账户显式 authserv-id 的 messageSecurity；检查 Date 与 Message-ID |
| structured-events  | 原 HTML 的 structuredMailEvents，保留 JSON-LD 检测路径                                         |
| snippet-plain-text | htmlToText 与 withDecodedBody 的纯文本和 snippet 生成                                          |
| fts-tokenize       | SQLite 的 trigram、unicode61，subject/body 使用与生产索引相同的 tokenizer                      |

FTS 阶段使用独立 `:memory:` 数据库的临时索引，每封处理后清空。只有这个易失内存索引执行插入和删除，邮箱数据库及其副本不执行任何写入。

| 异常                    | 含义                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sanitizer-text-loss     | 对阶段清洗结果重复应用阅读器管道后，可见字符数不足首次结果的 10%                                                                                                              |
| empty-visible-text      | HTML 非空但清洗后可见文本为空                                                                                                                                                 |
| budget-exceeded         | 可见性检查耗尽预算、模型文本拒绝复杂消息，或结构化事件超过其 100 万字符输入上限                                                                                               |
| charset-replacements    | 解码后消息文本与 HTML 的 U+FFFD 占 Unicode 字符数超过 1%                                                                                                                      |
| css-rule-budget         | 实际耗尽 visibleHtmlText 的 CSS 规则预算，来自解析器诊断钩子                                                                                                                  |
| oversized-html          | HTML 的 UTF-8 字节数大于 1 MiB                                                                                                                                                |
| nesting-depth-limit     | 实际触发可见文本提取的 512 层扁平化限制                                                                                                                                       |
| link-display-mismatch   | 整个可见标签本身为 URL／域名，且注册域与目标不同；普通词语、夹杂 URL 的句子、隐藏链接不计。CSS 预算耗尽时不计无法确认可见的链接。阅读器仍检查句子内嵌域名；不会访问重定向目标 |
| failed-date-parse       | 缓存时间戳无法转换为日期，或现有 Date 头解析失败；缺少 Date 头不计失败                                                                                                        |
| missing-message-id      | 缓存 RFC Message-ID 和现有 Message-ID 头均为空或缺失                                                                                                                          |
| structured-events-found | 识别出的结构化事件数                                                                                                                                                          |
| timeout                 | 单封总处理期限耗尽，worker 被终止；core 调用方取消时也会中断当前邮件                                                                                                          |
| message-size-limit      | 缓存字段超过 16 MiB，在 SQL 投影处跳过大字段，不读取其完整内容                                                                                                                |

响应式邮件分别在 720px 和 1080px 参考阅读宽度计算级联，只保留所有环境场景和两个宽度都可见的同一文本节点。解除隐藏还须覆盖 0–8000 整数 CSS px；light／dark 等媒体环境独立求级联，动态伪类不能建立显示信任。具体媒体条件和不确定环境的处理见[邮件内容保护](security.md#mail-content-protection)。只在 600px 以下隐藏的桌面版本可保留；默认隐藏、仅在窄屏显示的移动版本被排除。诊断计数按 DOM 节点统计一次，不累加两个宽度的结果。

读取使用 SQLite iterator，一次只发送一行、等待处理结束再继续。统计采用固定直方图，报告样本和失败类数量有上限；不积累邮件、链接、token 或逐封耗时。超时或 worker 失败后终止并重新创建 worker，继续下一封。解析器有独立 V8 堆上限，该限制不等于整个进程的 RSS 上限。

验证使用合成缓存、恶意 HTML、坏 JSON 和开启 WAL 的临时库，检查所有阶段、只读源文件、超时、样本上限及内容泄漏。CLI fixture 的汇总及 explain JSON 对每个主题、地址、消息文本词与私有 selector／tag 名逐一断言不存在；回归验证用私有密钥文件定位单封及跟踪链接的普通词语标签不计域名不符。真实缓存副本仅在用户明确授权后运行只读汇总检查，不输出邮件内容。

API 与 tokenizer 行为参考 [Node SQLite](https://nodejs.org/api/sqlite.html)、[Node Worker](https://nodejs.org/api/worker_threads.html)、[SQLite FTS5](https://sqlite.org/fts5.html) 和 [htmlparser2](https://github.com/fb55/htmlparser2)。
