# 性能

真实邮件缓存副本的内容脱敏检查见 [corpus-check](corpus-check.md)。

本页维护本地性能预算及复现命令。使用 Node 和 `node:sqlite`，不测量 Electron、模型下载或真实账户端到端时延。

## 10 万封邮件预算

运行真实迁移和 `Store.upsertMessage`，临时数据库包含 100,000 封邮件、3 个账户、200 个标签／文件夹、20,000 个会话，其中 100 个长会话各有 204 封邮件。消息文本含 CJK 和引用历史，HTML 使用仓库中的 newsletter、Outlook Word fixture；独立解析测试输入为 200 KiB UTF-8，含内联 CSS、隐藏内容和 JSON-LD 事件。数据库生成在系统临时目录，Layer 关闭后删除。SQLite 页缓存 8 MiB，Node 堆上限 192 MiB；Effect 时钟固定为 2026-10-03，缓存窗口不受测试运行日期影响。

fixture 默认不运行 `ANALYZE`，预算按新安装、还没有规划器统计时测量。设置 `OPENMAIL_PERF_ANALYZE=1` 测量有统计的情况。应用打开数据库时运行 `PRAGMA optimize=0x10002`（`analysis_limit=400`），同步循环每小时运行一次 `PRAGMA optimize`，见 `packages/core/src/db/migrate.ts`。

```sh
OPENMAIL_PERF=1 pnpm test:perf
# 可指定完整 SQL、查询计划和测量结果的输出位置：
OPENMAIL_PERF=1 OPENMAIL_PERF_REPORT=/tmp/openmail-performance.json pnpm test:perf
```

大数据套件是 `packages/core/src/platform/node/performance-large.test.ts`，默认 `pnpm test` 排除它。默认套件中的 `performance-plans.test.ts` 集中检查真实 Store 查询。同步健康与分页用例只写 120 封邮件；联系人用例保留原有候选规模。它们检查索引使用、分页回绕、孤立草稿去重和 Unicode ID 顺序。150k 迁移用例仅在 `OPENMAIL_PERF=1` 时执行。MCP 测量调用真实 Toolkit handler 与 Mailbox，provider 使用进程内 fake，不发网络请求。

`pnpm test:perf` 也运行 `visible-text-cost.test.ts`、`performance-plans.test.ts`（含 150k 迁移用例）、`src/domain/cache.test.ts`（含 10 万会话分页用例）、`recovery-safety.test.ts`（四个进程同时首次打开，每个须在 1 s 内拿到共享锁）和 `migration37-performance.test.ts`（100k 消息上的迁移 37，见下文）。随后它运行 `pnpm --filter @openmail/cli test:perf`，即设置 `OPENMAIL_PERF=1` 跑 CLI 的 `mcp-server.test.ts`：另一个进程持有写锁时，`list_accounts` 调用的中位耗时须低于 500 ms × `OPENMAIL_PERF_FACTOR`。perf.yml 因此也覆盖这些用例。

CI 中由 [perf.yml](../.github/workflows/perf.yml) 运行：每周一 06:00 UTC 定时，可在 Actions 页手动触发（workflow_dispatch），[release.yml](../.github/workflows/release.yml) 也通过 `workflow_call` 调用它，打 tag 发版前必须通过。它不在每次 push 的 check 中运行，push 时由下面写入速率预算的增长断言把关。job 在 macos-latest 上先用 `pnpm build --filter=@openmail/cli...` 构建 core 和 CLI（同步测量从 `dist/` 加载 HTML worker，MCP 测量启动构建好的 CLI），再执行 `pnpm test:perf`。套件只用 Node 和 `node:sqlite`，不开 Electron 窗口，不需要显示器或网络。共享 runner 噪声较大，job 设 `OPENMAIL_PERF_FACTOR=2`，所有墙钟预算乘以该系数；本地默认系数为 1，取值小于 1 或不是数字时按 1 处理。三份 JSON 报告（`OPENMAIL_PERF_REPORT`、`OPENMAIL_SPARSE_PERF_REPORT`、`OPENMAIL_SYNC_REPORT`）作为 `performance-report` artifact 上传，失败时也上传。长尾词表用例把各次时延和中位数写进 `OPENMAIL_PERF_REPORT` 同目录下的 `openmail-vocabulary-performance.json`，所以也在这个 artifact 里。系数实现见 `packages/core/test-support/perf-budget.ts`。日常套件的计时规则见[负载下的测试](testing.md#tests-under-load)。

每项先执行一次并单独采集 `EXPLAIN QUERY PLAN`，再取五次热运行中位数；remap、invalidate 和实际淘汰取三次。写入每次在事务末尾回滚，重复测量使用相同状态。断言中位数低于下表预算，JSON 同时保留各次时延、最大值和测量结束时的一／五／十五分钟负载。fixture 生成、查询计划采集及索引完整性检查不计入时延。

| 路径                                         | 预算 ms |
| -------------------------------------------- | ------: |
| provider ID 不命中查找                       |       5 |
| sync-health 标签本地计数／观察标签           |     150 |
| sync-health IMAP 本地计数                    |     100 |
| stale sweep 标签／IMAP 的 100 条候选页       |     100 |
| stale sweep claim 与游标保存                 |      25 |
| reset 账户七日窗口                           |     200 |
| reset 标签／IMAP 三十日窗口                  |     150 |
| reset 候选持久化                             |      50 |
| 未读账户／标签徽标                           |     100 |
| list_threads 首页 50 个会话                  |      75 |
| 常见词／CJK／运算符搜索，50 个会话           |     150 |
| 稀有一／二字 CJK 搜索，50 个会话             |      50 |
| 常见一／二字 CJK 搜索，50 个会话             |     150 |
| 输入中的前缀与双词搜索，50 个会话            |     150 |
| has:drive／has:spreadsheet，50 个会话        |      50 |
| label: 搜索（ID、名称、加常见词），50 个会话 |     200 |
| 标签列表视图（全部账户／单账户），50 个会话  |     200 |
| 消息文本＋OCR 搜索，200 个会话               |     100 |
| OCR 摘要搜索，50 个会话                      |     150 |
| AROUND 0 搜索，50 个会话                     |     500 |
| AROUND 3 搜索，50 个会话                     |     475 |
| AROUND 精确命中稀疏，100k 消息               |     500 |
| AROUND 深页游标，100k 会话                   |    1500 |
| getThread，204 封长会话                      |     100 |
| 长会话模型文本                               |     500 |
| 200 KiB HTML 可见文本                        |     150 |
| 200 KiB HTML 清洗                            |     200 |
| 200 KiB 结构化事件检测                       |     100 |
| MCP list_threads／search                     |     200 |
| remap 100 个身份                             |     250 |
| invalidate IMAP 文件夹                       |     500 |
| 各账户消息文本字节数                         |     150 |
| 消息文本预算全保护扫描                       |    5000 |
| 消息文本预算淘汰 1 MiB                       |     500 |
| 消息文本预算小时门控                         |      25 |

MCP 测量先为三个 fixture 账户打开 AI 权限，并断言 list_threads 和 search 都返回会话。此前没有授权，两项都返回空结果，测得 0.3 ms；授权后中位数约为 16 ms 和 75 ms。

fixture 中千分之一的邮件含 Google Sheet 链接，has:drive 和 has:spreadsheet 都要跳过大量不匹配行。迁移 45 在 `message_search_meta.search_flags` 记录 Drive 链接、附件类型和 `cid:` 内联图片，写入消息时由触发器计算；迁移前的行为 NULL，后台按批回填，查询只对这些行扫描消息文本和附件清单。改动前 has:drive 中位数 161 ms，has:spreadsheet 3021 ms；改动后分别约 12 ms 和 4 ms。附件类型规则冻结在 `SEARCH_FLAG_ATTACHMENT_TYPES_45`，测试要求它与 `ATTACHMENT_TYPES` 相同，规则变化须追加迁移。

预算淘汰测试将 INBOX 保留窗口设为 30 天，并断言实际淘汰了消息文本。小时门控测试在一次检查后再次调用；两者均回滚。完整预算扫描仍允许保留星标、草稿和无限窗口内的消息文本。

迁移 35 增加读取索引。扩展 provider ID 索引以覆盖 `ORDER BY date DESC,id`，避免不命中查找遍历整个账户；新增 IMAP 路径索引、远程草稿部分索引和消息文本字节数覆盖索引。索引定义已按下节的写入与空间验收缩减。stale sweep 从每个来源按 provider ID 取有界页，再按 SQLite BINARY 顺序合并；游标结束时回绕。日期分页使用覆盖元数据索引，先排除已有更近匹配的消息，再检查该行的全文条件。零距离 AROUND 按日期分页读取；非零距离先按日期读取 NEAR 候选窗口，只对窗口内消息计算词位置和分组；取得结果页后停止；最多两个候选窗口，超过后走全库查询。消息文本预算分页使用时间下界和 `(COALESCE(body_opened_at,date),id)` 继续定位，见 [SQLite 行值分页](https://www.sqlite.org/rowvalue.html#scrolling_window_queries)。索引维护增加写入和磁盘成本。

保留的扫描包括账户内标签 JSON、紧凑徽标投影、消息文本大小覆盖索引和 FTS 命中集合；它们不读取全部 HTML。reset 返回窗口内所有候选，`COUNT(DISTINCT thread_id)` 和已选长会话可使用临时排序。每条实际执行 SQL 的计划保存在临时 JSON；默认测试禁止裸扫大型 messages 表，并检查 stale 页没有全量 ORDER BY 排序。

## 写入速率预算

`seed-rate.test.ts` 在默认 `pnpm test` 中运行，所以每次 push 的 Check 都会跑增长断言。`pnpm test:perf` 也包含它，perf.yml 在那里断言总时间。它用真实打开路径（迁移加打开时的规划器统计刷新）新建一个文件数据库，再通过 `Store.upsertMessage` 写入 1 万封 fixture 邮件，每 500 封一个事务，每个事务单独计时，每 2,000 封为一段。每个事务前后各跑一次 CPU 校准切片（`perf-calibration.ts` 循环的三分之一，参考机约 11 ms），事务时间除以两个比值中较小的一个。取较小的，是因为只打在切片上、没打在事务上的突发负载会把事务时间除得过小。两条断言：

- 增长：最后 2,000 封各事务校准后时间的中位数，与前 2,000 封的中位数之比低于 2.5。参考机上是 1.1。中位数去掉单个被突发负载打中的事务或切片。默认套件只断言这一条。在 16 核机器负载 29–43 下连跑三次，增长是 1.09、0.65、1.34；按段求和的旧算法同样三次是 1.11、0.20、1.26，0.20 那次第一段有一个 3.9 s 的突发。
- 总时间：低于 6,000 ms × `OPENMAIL_PERF_FACTOR` × max(1, 校准比)，校准比取完整校准和各切片中的最大值。参考机上约 3.7 s。只在设置了 `OPENMAIL_PERF=1` 时断言，即 `pnpm test:perf` 和 perf.yml。Check 的共享 runner 上它在 6 次 push 中失败 2 次，同期增长只有 1.17 倍，所以 Check 不断言它。

失败信息写出总时间、预算、校准比和每段时间。打开时的 `PRAGMA optimize` 曾给空 FTS5 表记了统计（`d5194310` 修复）。把这个回归放回去后，同一台机器上总时间是 12.8 s，最后一段是第一段的 4.9 倍。按事务校准、取中位数后，在负载约 40 下复测两次是 5.07 倍和 5.74 倍，总时间 21.8 s 和 17.2 s，增长断言失败。

## 校准比

共享 runner 的速度每次不同，单看毫秒数无法比较两次 CI 运行。本地交替测量 `a4d1e203` 和 `53688a59`，10 万封写入都约 40.5 s，CI 上两者却差一倍，差距来自 runner 负载。性能套件开始时先在空闲进程里跑一段固定工作（`packages/core/test-support/perf-calibration.ts`）：

- `cpuMs`：3,000 万次整数哈希的纯 JS 循环，取三次中位数。
- `sqliteMs`：在临时文件数据库（WAL）里向带索引的表插入 20,000 行，每 2,000 行一个事务，取三次中位数。

`ratio` 是两者相对参考机（Apple M3 Max，Node 24：CPU 33 ms，SQLite 35 ms）的几何平均。2 表示这台机器跑同样的固定工作慢一倍。

三份报告都带 `calibration`。`openmail-performance.json` 还有 `seedPhases`（写邮件、OCR 文本块、词索引回填、二元组索引、ANALYZE 各阶段毫秒数）和 `calibratedSeedPhases`，每条查询结果有 `calibratedMs`。`calibratedMs = medianMs / ratio`，即换算到参考机的耗时。比较两次运行时看 `calibratedMs`：原始时间翻倍而 `calibratedMs` 不变，是 runner 变慢；`calibratedMs` 也翻倍，是代码变慢。预算断言仍按原始毫秒和 `OPENMAIL_PERF_FACTOR` 判断，校准比只用来读报告。例外是上面的写入速率预算，它的预算乘以校准比。

## 一／二字 CJK 搜索

trigram 索引只能回答三个字符以上的词。一或两个汉字、假名、韩文或泰文等字符的搜索原先对每封邮件的主题、发件人和消息文本跑 LIKE，并对全部派生文本跑 LIKE。迁移 48（user_version 48）新增两个无内容 FTS5 表 `messages_bigrams` 和 `derived_bigrams`，`ascii` tokenizer，`detail=column`，`prefix='1'`。`search-bigrams.ts` 把这些文字的每个字符写成一个词：与下一个同类字符组成二字词，连续段末尾的字符单独成词。二字搜索查完全相同的词，一字搜索查以该字开头的词，结果与 LIKE 相同。无内容表不保存文本，开启 `contentless_delete`，SQLite 须为 3.43 及以上；Node、Electron 和 op-sqlite 内置的版本均满足。

词在 JavaScript 里生成，触发器只把新增、改动或迁移前的行写入 `search_bigram_pending`，改动或删除时立即删掉旧词。启动后的后台循环和每次变更后 2 秒的去抖任务按每批 200 行写入，每批一个事务。队列中的行仍用 LIKE 查，因此任何时刻结果都完整，回填未完成时只是更慢。与 trigram 相同，探测超过 2048 条命中的常见词改为沿日期索引逐行检查。

100k fixture 中十封邮件含“鲸鱼”。2026-10-13 在同一 fixture 上运行四项，五次热运行中位数，单位 ms；`OPENMAIL_PERF_MEASURE` 可用逗号分隔多个名称。一分钟负载 10–29，高于 12，结果只作对比：

| 测量           | 修复前 | 修复后 |
| -------------- | -----: | -----: |
| 稀有二字“鲸鱼” |  127.1 |    4.5 |
| 稀有一字“鲸”   |  123.7 |    3.6 |
| 常见二字“预算” |   28.2 |   15.4 |
| 常见一字“会”   |   30.1 |   16.0 |

```sh
OPENMAIL_PERF_MEASURE="search CJK rare 2-char,search CJK rare 1-char,search CJK common 2-char,search CJK common 1-char" pnpm test:perf
```

## 输入中的前缀搜索

搜索框把未输完的最后一个词按前缀查，`we` 查 `we*`。`messages_words` 没有 prefix 索引，前缀查询每次都要合并所有以它开头的词的 doclist。常见词沿日期索引逐行检查时，原先对每行开一次 MATCH，前缀因此每行都合并一遍：100k fixture 上 `pe*` 查 200 个会话要 5.9 s。现在行内检查的前缀改为判断 rowid 是否在该前缀的命中集合里，集合每条语句只建一次，写成 `(m.rowid+0) IN (...)`，不让集合驱动日期遍历。精确词仍逐行探测。几个普通词同时出现在多数邮件里时（如 `weekly de*`），`planTextPage` 也探测组合 MATCH，超过 2048 条命中就走日期遍历；原先从第一个词的全部 rowid 出发，`weekly delivery` 查 50 个会话要 67 s。附件命中的代表邮件按 id 查，不再沿用常见词的日期遍历。

2026-10-16 在同一份数据上测，Node v24.21.0，五次热运行中位数，一分钟负载 4–15，单位 ms，50 个会话：

| 测量                 | 修复前 | 修复后 |
| -------------------- | -----: | -----: |
| fixture `we*`        |    376 |     77 |
| fixture `pe*`        |   1654 |    131 |
| fixture `weekly de*` |  69417 |    111 |
| fixture `weekly`     |     34 |     34 |
| 长尾词表 `co*`       |    973 |     80 |
| 长尾词表 `re*`       |   1227 |     86 |

几乎每封邮件都命中的前缀另有用例。长尾词表里 `se` 开头的音节有 se 和 sel 两个，`se*` 约对应 2,500 个词，10 万封邮件全部命中。原先结果页每次都对选中邮件跑一次 BM25，`MATCH` 用全部高亮词，前缀要展开它开头的每个词：`se* co*` 共 157 ms，其中 BM25 占 47 ms。BM25 只用来在附件文字也命中时给邮件排序，现在 `loadRelevance` 只在页里有附件命中时运行。2026-10-16 同一份数据，五次热运行中位数，单位 ms，50 个会话：

| 测量       | 修复前（负载约 22） | 修复后（负载约 10） |
| ---------- | ------------------: | ------------------: |
| `se*`      |                  88 |                  62 |
| `se*` flat |                  64 |                  37 |
| `se* co*`  |                 157 |                 111 |
| `a*` flat  |                  41 |                  25 |

这些用例的预算都是 150 ms。[search-relevance.test.ts](../packages/core/src/store/search-relevance.test.ts) 在默认套件里检查没有附件命中时不跑 BM25，有附件命中时主题命中排在正文命中前面。

长尾词表用例在 `performance-large.test.ts` 里另建 100k 邮件，词从 5 万个合成词中按重头长尾分布抽取。默认套件的 `search-prefix-plans.test.ts` 用 3,000 封邮件对照按消息文本直接计算的参考结果，覆盖前缀、精确词、双词、翻页和账户范围，并检查前缀没有逐行 MATCH。prefix 索引能把 `co*` 的 MATCH 从约 13 ms 降到 2 ms，但词索引变为 2.4 倍，升级时要重建，暂不加。

## label: 搜索与标签列表

第 18 轮让 `label:` 按名称不分大小写匹配后，100k fixture 上一次 `label:Folder_5` 要 20 s。原因有两个：

- 名称分支写成 `j.value IN (SELECT id FROM labels WHERE account_id=m.account_id AND name=? COLLATE NOCASE)`。子查询引用 `m.account_id`，SQLite 为每封邮件重建一次 IN 列表。100k 行计数用时 912 ms，不引用 `m` 时 143 ms。
- 会话页的过滤先写 newest-in-thread 检查（`NOT EXISTS (SELECT 1 FROM candidates n …)`），再写该行自己的条件。日期遍历的每一行都先跑这个检查，检查又对会话里每封更新的邮件跑完整过滤，标签判断合计约 200 万次。

改动：

- 名称查找改成 `(m.account_id,j.value) IN (SELECT account_id,id FROM labels WHERE name=? COLLATE NOCASE)`，每条语句只建一次列表。ID 和系统标签的匹配不变。
- 日期遍历（`listIndex` 给出索引时）先判断该行自己的过滤，再做 newest-in-thread 检查：`CASE WHEN 过滤 THEN newestMatch ELSE 0 END`。不走日期遍历时写成 `过滤 AND newestMatch`。全部套 CASE 会让规划器看不到 `m.id IN (…)` 和搜索标志位：has:drive 从 15 ms 变成 320 ms，CJK 从 3.4 ms 变成 371 ms。
- `label:` 加常见词（`label:Folder_5 weekly`）原先从 `weekly` 的全部 rowid 出发，读 100k 行再排序，约 1.5 s。`planTextPage` 现在允许只带 `label:` 的搜索走日期遍历：遍历时先判断标签和可搜索性，再做 newest-in-thread 检查，最后才对候选会话头逐行 MATCH。乐观的 `recent` 窗口也先判断该行条件。`messages_list_date_id` 覆盖 `labels_json`，标签判断不读表。其他运算符仍不走这条路。计数不能在文字索引上判断标签，`countThreads` 对带 `label:` 的搜索按行计数。
- 单账户的标签列表和 Inbox 以外的邮箱视图（如 Starred）也走 `messages_list_date_id`。原先走 `messages_account_list_date_id`，这个索引不含 `labels_json`，遍历的每一行都要读表，一个占 1/67 邮件的文件夹要 600 ms。单账户 Inbox 仍走账户索引。

2026-10-17 在评审者的 100k fixture 副本上测（`seedMailbox(100_000)`，未运行 ANALYZE），Node v24.21.0，三次热运行中位数，50 个会话，单位 ms。修复前一分钟负载 11–64（16 核），修复后约 11：

| 测量                             | 修复前 | 修复后 |
| -------------------------------- | -----: | -----: |
| `label:Folder_5`                 |  20390 |     16 |
| `label:"folder 5"`               |  20150 |     20 |
| `is:unread label:Folder_7`       |   2085 |     13 |
| `label:Folder_5 OR from:person7` |  17828 |     39 |
| `label:Folder_5 weekly`          |  30076 |     36 |
| `label:Folder_5 we*`             |  33903 |     66 |
| `label:INBOX weekly`             |  57539 |     35 |
| `label:Folder_5`，单账户         |   7216 |     25 |
| `label:Folder_5 weekly`，单账户  |   8078 |     68 |
| Starred 列表（0 个结果）         |   1184 |     34 |
| 标签列表，全部账户               |   1721 |     22 |
| 标签列表，单账户                 |    575 |     21 |
| `weekly`                         |     32 |     30 |
| `we*`                            |     63 |     63 |
| `pe*`                            |    107 |    107 |
| `预算`                           |     17 |     17 |
| has:drive                        |     12 |     11 |
| `in:inbox`                       |     12 |     13 |
| Inbox 列表                       |     11 |     13 |

两边的结果页、第二页和计数逐项相同。只做前两项时，`label:Folder_5 weekly` 取 200 个会话仍要 1.5 s；加上第三项后为 68–91 ms。

[search-label-plans.test.ts](../packages/core/src/store/search-label-plans.test.ts) 在默认套件里用 3,000 封邮件对照按标签和消息文本直接计算的参考结果。它覆盖标签 ID、名称和大小写、两个账户同名不同 ID 和同 ID 不同名、系统标签、否定、OR、与词和 `is:` 组合、会话与平铺、单账户、第二页和计数，也覆盖标签列表和 Important 视图。它还检查查询计划里标签查找前面没有 `CORRELATED`，日期遍历先判断标签再找会话里更新的匹配，MATCH 排在这个检查之后。`performance-large.test.ts` 的 `search label:` 三项和 `list label view` 两项预算为 200 ms，`OPENMAIL_PERF=1` 跑一次的中位数为 15、17、35、19、21 ms。

试过把 `messages_account_list_date_id` 扩成覆盖 `labels_json` 的索引。没有统计时规划器换了计划，单账户标签列表从 578 ms 变成 23 s，单账户 Inbox 从 15 ms 变成 2.5 s，所以没有加迁移。标签列表现在已在 30 ms 内，`message_labels(account_id,label,row_id)` 副表也不再需要。

找不到结果的运算符搜索见下一节的“to:、cc:、filename:、list:”。

## subject:、OR 与运算符搜索

2026-10-17 评审者在两份数据上测出三类慢搜索。fixture P 是上面的 100k fixture（`seedMailbox(100_000)`，含 10k 个 OCR chunk）。fixture R 是一个 Gmail 账户的 100k 封约 10 KB 的邮件加一个 Outlook 账户的 2k 封，数据库 2.3 GB，分有和没有规划器统计两份。下面的数字都在 Node v24.21.0 上测，取 50 个会话，单位 ms，三次热运行取中位数；“冷”是进程打开数据库后的第一次。修复前后的结果页、第二页、未读／星标、会话数和计数逐项相同。

### subject: 常见词

`subject:report` 在 fixture P 上要 53 s，单账户 19.8 s。两个原因：

- 会话页的 `page` CTE 在 select 列表里算未读和星标（两个 EXISTS 查 `flag_candidates`），排在 `ORDER BY … LIMIT` 前面。页从文字索引的 rowid 出发时，SQLite 对每个匹配行都算一次，每行约 1 ms。
- `subject:` 给查询设了 criteria，`planTextPage` 提前返回，不走日期遍历，只能从 `subject : "report"` 的 100k 个 rowid 出发。

改动：

- 未读和星标移到外层 SELECT，只对 `page` 选出的最多 limit 行计算。
- `planTextPage` 让 `subject:` 和 `label:` 一样可以走日期遍历：把 `(subject : "report")` 和其他词用 AND 拼进 `commonTerm` 的探测，超过 2048 行就遍历日期索引，每行按 rowid 探测 MATCH。计数仍用文字索引。
- 会话页的 unsearched 超集去掉 `subject:`，和普通词一样。保留时，newest-in-thread 检查对每个遍历行的每封更新回复都探测一次 MATCH。fixture P 最新的 20k 封邮件属于 100 个 204 封的长会话，单账户约 3 万次探测，900 ms。

带其他运算符的 `subject:`（如 `subject:report -from:person1`）仍从 rowid 出发，只得到第一项改动：48 s 到 329 ms。

fixture P，修复前后（未运行 ANALYZE）：

| 测量                               | 修复前 | 修复后 |
| ---------------------------------- | -----: | -----: |
| `subject:report`                   |  54770 |     18 |
| `subject:report`，单账户           |  20331 |     65 |
| `subject:"weekly report"`          |  52537 |     18 |
| `subject:"weekly report"`，单账户  |  20804 |     65 |
| `subject:weekly is:unread`，单账户 |  20015 |     86 |
| `subject:report -from:person1`     |  48282 |    329 |
| `-to:nobody weekly`                |  53985 |    483 |
| `subject:report`，平铺             |    134 |      7 |

`-to:nobody weekly` 也从 rowid 出发，同样只受益于第一项。

计数不能用文字索引时（带 `is:unread` 等条件）按行计数。原来它沿用页面的逐行 MATCH 探测，对 100k 封邮件每封探测一次；现在计数改用文字索引的 rowid 集合，每个匹配都要读，集合更省。fixture P 上 `subject:weekly is:unread` 的计数 288 ms 到 77 ms，`weekly is:unread` 288 ms 到 76 ms，`weekly delivery is:unread` 559 ms 到 89 ms，数值不变。

[search-operator-plans.test.ts](../packages/core/src/store/search-operator-plans.test.ts) 在默认套件里用 3,000 封邮件（含一个 60 封的长会话）对照按存储的字段直接计算的参考结果，覆盖单词、短语、大小写、前缀、与普通词和 `is:` 组合、否定、会话与平铺、单账户、第二页和计数。它还检查 `page` CTE 里没有 `flag_candidates`，常见 `subject:` 词的 `recent` 窗口走日期索引且不含 `messages_words`，按行计数的语句不按 rowid 逐行探测。`performance-large.test.ts` 的 `search subject: common` 和 `search subject: phrase` 预算 200 ms。

### OR 与附件文字

OCR 和 PDF 文字建好索引后，fixture P 上的 OR 搜索要 13–18 s。两处相同的毛病：一个对 chunk 的条件按邮件逐个探测。

- 给返回的会话补附件命中的语句（`store-search-matches.ts`）写 `m.id IN (选中会话的邮件 id)`。没有统计时规划器从 `derived_words MATCH` 出发，每个匹配 chunk 都按每个选中 id 探测一次 `derived_chunks_message`。改成 `+m.id IN (…)` 后，chunk 按自己的 rowid 找到邮件。评审者单测这条语句：13,016 ms 到 25 ms；`weekly OR alpha` 整个请求 14,752 ms 到 89 ms。
- 页面过滤里每个词对附件文字写成 `EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND d.id IN (SELECT rowid FROM derived_words WHERE derived_words MATCH ?))`。IN 列表是全部匹配 chunk，SQLite 对每封被检查的邮件按列表里的每个 chunk id 探测一次索引。`invoice OR weekly` 里 invoice 在全部 10k 个 chunk 中，只改上一项时仍要 4.3 s。现在每条语句只建一次邮件 id 集合：`+m.id IN (SELECT d.message_id FROM derived_chunks d WHERE d.id IN (MATCH))`，和前缀词的 `(m.rowid+0) IN (…)` 一样不让集合驱动遍历。词索引和 trigram 索引走这个集合；bigram 队列中的行和 LIKE 仍逐封判断。

fixture P，修复前后：

| 测量                             | 修复前 | 修复后 |
| -------------------------------- | -----: | -----: |
| `weekly OR alpha`                |  13284 |     91 |
| `weekly OR alpha`，单账户        |   9437 |     82 |
| `(weekly OR delivery) is:unread` |  13389 |     81 |
| `invoice OR weekly`              |  17805 |    104 |
| `invoice OR weekly`，单账户      |  12055 |     96 |
| `invoice OR weekly` 计数         |  21536 |    161 |
| `invoice OR weekly` 平铺计数     |  20181 |     95 |
| `invoice OR zzzzunmatched`       |  17617 |     65 |
| `weekly OR 鲸鱼`                 |    103 |     98 |

计数也用页面过滤，所以 `invoice OR weekly` 的计数从 21.5 s 降到 161 ms。search-operator-plans.test.ts 的 OR 部分覆盖普通词、`is:` 组合、只在附件文字里的词、否定和 `subject:`，有附件命中的页按相关度排序，只比较会话集合。它检查附件文字的查询计划里没有按 `derived_chunks_message (message_id=? AND rowid=?)` 的逐行探测，补附件命中的语句写 `+m.id IN`。小数据库在没有统计时也不会选中旧的坏计划，所以后一项只检查语句文本。`performance-large.test.ts` 的 `search OR`、`search OR is:unread` 和 `search attachment word OR common` 预算 200 ms。

### to:、cc:、filename:、list:

找不到结果的 `to:`、`cc:`、`filename:`、`list:` 要检查每封邮件：读出这一行，再对 `to_json`、`cc_json`、`attachments_json` 或 `headers_json` 跑 `json_each`。`to_json` 和 `cc_json` 在 `body_text` 前面，`attachments_json` 和 `headers_json` 在后面。成本主要是逐行随机读页加 `json_each`。fixture P 上 1–2 s，评审者在 2.3 GB 的 fixture R 上冷读最多 6 s。

迁移 57 加了副表 `message_operator_text(row_id, to_text, cc_text, file_text, list_id_text, list_post_text)`，每封邮件一行，SQL 在 `packages/core/src/db/operator-text.ts`：

- 每列用 char(30) 连接多个值，姓名和地址之间用 char(31)。不含这两个字符的 LIKE 模式只能在一个值内命中，和原来逐个 `json_each` 值判断相同。搜索值含这两个字符或为空时仍用原来的逐行判断。
- `messages` 上的 INSERT、UPDATE、DELETE 触发器维护这张表，先删后插。UPDATE 触发器只在四个 JSON 列真的变了时执行，只改标签的同步不写副表。`json_valid` 和 `type='object'` 跳过坏 JSON，写入不会因此失败。
- 迁移本身不回填：在 2.3 GB 上一次回填要 13.7 s，而迁移在启动窗口里同步运行。`message_operator_text_backfill` 记下迁移时的最大 rowid，后台循环（`mailbox-live.ts`，在词索引和 has: 标志之后）每批 200 行提交一次，可中断、可续。回填完成前，这几个运算符继续用原来的逐行判断，结果不变；完成后改成 `(m.rowid+0) IN (SELECT row_id FROM message_operator_text WHERE to_text LIKE ? ESCAPE '\')`，`+0` 不让集合驱动遍历。新安装时迁移看到空表，直接标记完成。

写入成本：1 万封带收件人、附件和 List-Id 的邮件，插入从 2.75 s 到 2.84 s（+3%），只改标签的再次写入从 2.15 s 到 2.17 s。回填每批 200 行，和词索引的默认批量相同：

| 数据                   | 总时间 | 批数 | 每批 p50 | 每批 p95 | 最慢一批 |
| ---------------------- | -----: | ---: | -------: | -------: | -------: |
| fixture P（600 MB）    |  1.9 s |  500 |     3 ms |     5 ms |    38 ms |
| fixture R（2.3 GB）    | 17.2 s |  510 |    27 ms |    35 ms |   402 ms |
| fixture R，每批 500 行 | 14.4 s |  204 |    63 ms |   100 ms |   249 ms |

每批 500 行时 p95 到 100 ms，写锁占得更久，所以用 200。两种批量的最慢一批都是零星的 250–400 ms，出现在中途，和批量无关。

fixture P，修复前后：

| 测量                                | 修复前 | 修复后 |
| ----------------------------------- | -----: | -----: |
| `to:nobody@example.com`             |   1926 |     20 |
| `to:nobody@example.com`，单账户     |    685 |     11 |
| `cc:nobody`                         |   1034 |     18 |
| `filename:none.pdf`                 |   1117 |     19 |
| `list:nolist`                       |    926 |     22 |
| `to:nobody OR cc:nobody`            |    177 |     27 |
| `to:recipient`（每封都命中）        |     13 |     63 |
| `to:recipient`，平铺                |    0.3 |     13 |
| `filename:report.pdf`（1/10 命中）  |     49 |     26 |
| `-filename:report.pdf from:person1` |     22 |     42 |
| `to:recipient filename:report`      |     80 |     78 |

代价在常见命中：原来日期遍历的前几十行就填满一页，现在每条语句要先扫一遍副表建集合。会话页的 `candidates`、`flag_candidates` 和 `page` 各扫一次，fixture P 上每次约 15–20 ms，所以 `to:recipient` 从 13 ms 变成 63 ms。找不到结果和稀疏命中从秒级降到 20 ms 左右，所以接受这个代价。

search-operator-plans.test.ts 的运算符部分覆盖四个运算符、大小写、`_` 转义、空收件人和 NULL 头部、否定、OR、组合、会话与平铺、单账户、第二页和计数，并在四种状态下对照参考结果：新库（无需回填）、模拟的旧库（三分之一的行没有副表行，回填未开始）、回填一半、回填完成，以及通过 `upsertMessage` 改收件人、附件和头部、只改标志、`deleteMessage` 删除和新写入之后。每种状态都检查查询用的是副表还是逐行判断，并把副表和按 `operatorTextValues("m")` 重新计算的结果逐行比较。另一个测试从 user_version 56 的库升级，确认迁移不回填、搜索在回填前后结果相同。`performance-large.test.ts` 的四个 `no match` 测量预算 200 ms。

### 慢 RPC

桌面主进程的 RPC 协议（`apps/desktop/src/main/rpc/rpc-security.ts`，本机窗口和远程访问共用）记下每个请求的开始时间。请求在 1 s 或更久后才返回时，用 `logWarning` 写一条 `rpc-slow`：只有 RPC 名称和耗时，例如 `RPC Threads took 2400 ms`，不含查询文字和参数。诊断文件只记代码 `rpc-slow`。同一个 RPC 每分钟最多一条，一阵慢搜索只留一行。`Events`、`Downloads` 这类流在窗口存在期间一直打开，不计时；客户端中断的请求也不计。

## 消息文本与附件检索排名

普通词查询分别选取日期窗口内的消息文本候选和 FTS 排名靠前的附件候选，再合并。消息文本窗口为请求 limit，附件窗口同样为 limit；这是有界候选排名，不保证整个邮箱的全局相关度顺序。布尔、排除和 AROUND 查询沿用原条件选择候选，再给返回的会话补附件来源。消息文本和主题使用 [FTS5 BM25](https://sqlite.org/fts5.html#the_bm25_function) `bm25(index,4,0,0,1)`，主题权重 4、消息文本权重 1、发件人权重 0；附件使用 `bm25(derived_words)`。两个消息 FTS 都按缓存的原始 `body_text` 建外部内容索引；可见消息文本只存在于语义向量项，未建可供 BM25 查询的 FTS。复用现有消息 FTS 计算候选顺序，避免在只读搜索中改索引或重写消息文本；来源分类、摘要和精确短语信号始终取经过可见性提取的消息文本，隐藏内容不成为邮件命中信号。负分越小越相关。词索引未完成或 CJK 子串查询使用 trigram 索引，无法提供 FTS 分数的短词保留日期顺序。

存在附件文本命中时，对各路候选先按 BM25 排序，再计算 `score(m) = (w_mail + p × exact_mail)/(60+r_mail) + (1 + p × exact_attachment)/(60+r_attachment)`。排名从 1 开始，exact 为 0 或 1，缺席的一路贡献为零；`w_mail = max(2, (60+N_mail)/60)`，N 为消息文本候选数；普通附件权重为 1。任一路含连续多词短语时加同一个 `p = 1.5 × w_mail - 1`：消息文本／主题精确命中的权重为 `w_mail + p`，附件精确命中的权重为 `1 + p`。主题和可见消息文本分别检查，不把两个字段拼成短语。这样同为精确短语时仍保留邮件优先，附件精确短语仍可超过分散的邮件词命中。两路都命中的会话相加，每路每个会话只计一次，不因页数或 OCR chunk 数量增加得分；同分按日期降序。没有附件文本命中时保留原日期分页顺序。桌面排名搜索通过扩大候选窗口加载更多，避免用相关度末行的日期翻页。消息文本权重下限 2 让普通主题／消息文本命中优先；候选超过 60 时按窗口扩大权重，保证最后一个消息文本候选仍优于普通附件首位，连续短语允许附件越过分散的消息文本命中。RRF 避免直接比较消息文本与附件两个语料库的 BM25 数值。固定排序与隐藏文本回归见 `search-snippets.test.ts`。

摘要在有界结果窗口生成，只从 `messageModelText` 的可见消息文本取词，不使用 provider preview 或语义索引中旧的消息文本 chunk。派生文本含 HTML 时也走可见文本提取；纯 OCR／PDF 提取文本作为不可信字符串。摘要约 240 个 UTF-16 单位，围绕首个命中截取，保留完整的长短语；词索引未完成时，标记也按对应的 trigram／LIKE 子串规则生成；字段包含 `source`、`messageId`、附件名／索引、纯文本 `snippet` 和 UTF-16 `highlights`。React 用文本节点和 `mark` 显示，MCP 和 CLI 仍放在 `untrusted_mail` 封装内。阅读器展开命中的邮件，并按附件索引标记附件，重名文件不混淆。阅读器现有 PDF 页码和 OCR 图片区域入口保留。十种语言新增附件来源提示；本轮不启动 Electron。

100k fixture 给每个附件加入一个 OCR chunk，共 10,000 个，四类长度、词频和词间距不同的固定文本会实际影响 BM25。`search mixed body+OCR 200` 按桌面首个搜索窗口查 200 个混合结果，预算 100 ms；加载更多仍通过扩大并重新查询窗口。`search OCR snippet` 通过真实 Store 查 50 个结果，并检查附件名与标记范围，预算 150 ms。宽词搜索和派生候选通过已维护的 `message_search_meta.eligible` 排除垃圾邮件／废纸篓，避免逐命中两次解析标签 JSON。主题均有可见命中、消息文本窗口已满且只有一个词时，普通 OCR 独占命中按上述权重无法进入结果页，因此只读取该窗口内会话的附件命中。多词、短语和消息文本不足一页时仍查询独立附件候选。FTS 路径直接在命中游标上计算附件 BM25；会话先按排名选一封最新匹配的代表消息，再读取摘要与参与者，未读／星标仍按所有匹配消息聚合，不读取每个 chunk 对应的完整摘要；消息分数用物化 CTE 一次计算，先按候选 rowid 的最小／最大值限制游标范围，再以数值表达式筛选 rowid，避免 FTS 对每个 rowid 重开游标并重算语料统计；只读取结果代表消息与确需复核可见性的消息文本 chunk。避免逐行子查询反复扫描 FTS 集合。宽词列表用 CASE 先排除已有较新匹配的回复，再对候选会话头检查 MATCH；未读和星标通过匹配消息上的短路 EXISTS 生成，两路候选共用已取得的会话计数与参与者。可见消息文本只读取实际生成摘要的邮件，不重复读取未使用的附件代表消息。复杂表达式先筛派生文本命中，再核对原条件。同一请求中相同消息文本／HTML 的可见文本结果、相同 chunk 的摘要与标记范围复用，不跨请求缓存；同一对象的命中列表合并也跳过去重序列化。

混合搜索剖析工具见 [search-profile.test.ts](../packages/core/src/platform/node/search-profile.test.ts)，按每条 SQL 和内存步骤计时，并在计时外采集完整查询计划。主 SQL 从 91.10 降至 28.72 ms，整条请求从 157.09 降至 76.52 ms。常见词第一页整页会话头命中时跳过全库 FTS 集合，缺少命中或使用游标时回退；追加迁移为参与者和星标查询提供覆盖索引。 同步执行相同 schema 解码，保留全部边界验证。

```sh
OPENMAIL_SEARCH_PROFILE=1 NODE_OPTIONS=--max-old-space-size=192 pnpm --filter @openmail/core exec vitest run src/platform/node/search-profile.test.ts
```

剖析默认使用 `/tmp/openmail-search-profile.db`，空库生成真实 100k fixture。默认库在连接关闭后删除，成功、失败和中断均执行清理；显式指定的其他测试库保留，便于多轮比较。预热两次后取七次中位数，热运行的 SQL prepare 全部命中缓存。`OPENMAIL_PROFILE_DATABASE` 和 `OPENMAIL_PROFILE_REPORT` 可指定测试库及报告位置。原始计时与查询计划留在临时目录，不提交生成报告。

## 2026-10-06 回归定位

在 `d0d820a` 至 `7438fba` 间二分，并核对候选提交两侧。每点先 `pnpm install --frozen-lockfile` 和构建 core，再运行只保留 AROUND 与长线程模型文本的临时预算测试。环境与 `test:perf` 相同：Node v24.21.0、`OPENMAIL_PERF=1`、`OPENMAIL_LOW_MEMORY_TESTS=1`、192 MiB 堆、8 MiB SQLite 页缓存。每点连续测三轮，每轮单独预热并取五次中位数；计时排除查询计划采集。系统负载约 6–11，因此小幅差异不作为回归证据。

两个端点及 `7fbce29` 各自生成完整 fixture。其余点复制 `7fbce29` 完成词索引并 truncate WAL 后的同一份 100k 数据库，再运行各提交的迁移和 `ANALYZE`；这些提交在迁移 37 前的 schema 相同。测量串行执行。以下为三轮中位数，单位 ms。

| 提交      |            search AROUND | thread model text long chain |
| --------- | -----------------------: | ---------------------------: |
| `d0d820a` | 601.91 / 595.27 / 583.36 |     133.17 / 124.14 / 133.57 |
| `24e3b58` | 608.13 / 632.76 / 601.80 |      111.44 / 100.46 / 97.44 |
| `3dfdebe` | 601.75 / 595.70 / 592.48 |      110.89 / 100.56 / 99.45 |
| `99cd1ef` | 606.17 / 678.08 / 625.84 |     110.58 / 112.39 / 110.03 |
| `94ecc1b` | 619.26 / 658.02 / 606.88 |     362.58 / 351.04 / 351.14 |
| `7fbce29` | 650.05 / 695.32 / 681.77 |     410.73 / 388.55 / 394.73 |
| `be420e7` | 631.27 / 607.16 / 612.63 |     406.09 / 383.61 / 366.62 |
| `9ce7fbc` | 599.76 / 611.23 / 600.54 |     426.85 / 361.87 / 387.64 |
| `4ccf97d` | 634.88 / 597.96 / 593.48 |     425.29 / 406.34 / 411.03 |
| `7438fba` | 611.38 / 610.64 / 616.83 |     443.58 / 379.75 / 378.03 |

AROUND 在起点已超过 500 ms，十个历史点的实际 `EXPLAIN QUERY PLAN` 完全一致，未发现本区间内引入该问题的提交。迁移 37 没有改变此计划，保留原索引及迁移。开销来自距离为零时仍物化候选词位置、自连接和去重。修复将距离为零的有序查询编译成一个 [FTS5 短语](https://www.sqlite.org/fts5.html#fts5_phrases)，无序查询匹配两个方向的短语；非零距离仍使用原位置检查，索引未完成时仍走 AND 回退。计划测试要求零距离不读取词位置表，非零距离只读取一次。

长线程文本回归来自 `94ecc1b`：其父提交 `99cd1ef` 约 110 ms，该提交约 351 ms。HTML5 清洗、多个参考宽度与媒体场景的可见性检查增加了逐封提取成本。fixture 的 204 封长线程只有两组相同的纯文本／HTML，却重复提取 204 次。修复在单次 `toModelThread` 调用内按完整纯文本和 HTML 复用结果；仍逐封处理引用边界、标志和文本预算。无跨调用缓存，全部消息文本均不同的线程不会获得这项复用收益。存储拆分、引用边界修改和可见文本阶段重构没有显示同等幅度的独立回归。

在同一份快照上比较 `7438fba` 与修复，每格按三轮列出中位数，括号内为该轮最大值，单位 ms。两个预算均保持 500 ms。

| 测量                         |                                              修复前 |                                              修复后 |
| ---------------------------- | --------------------------------------------------: | --------------------------------------------------: |
| search AROUND                | 611.38 (717.91) / 610.64 (710.98) / 616.83 (632.50) | 365.57 (403.08) / 371.92 (376.95) / 372.83 (380.32) |
| thread model text long chain | 443.58 (465.15) / 379.75 (428.80) / 378.03 (406.81) |       91.04 (95.74) / 89.89 (90.59) / 88.73 (88.92) |

## 2026-10-07 AROUND 分页回归排查（slice 89）

在 `/tmp` 的独立 worktree 测量 `1b7a975..6c04688`，每个提交先安装冻结依赖并构建 core。过滤测量只执行真实 Store 的 `listThreads({ search: '"alpha AROUND 0 beta"', limit: 50 })`，环境与 `test:perf` 相同：Node v24.21.0、`OPENMAIL_PERF=1`、`OPENMAIL_LOW_MEMORY_TESTS=1`、192 MiB 堆、8 MiB SQLite 页缓存。每点连续三轮，每轮预热一次后取五次中位数；另采集实际 SQL 的 `EXPLAIN QUERY PLAN`，不计入测量。每轮前后记录一分钟、五分钟、十五分钟负载，表中列出一分钟范围。测量串行执行。

初次独立生成 `6c04688` fixture 得到 530.17 / 512.37 / 472.33 ms，负载约 9。另在 `1b7a975` 和 `cea6d24` 分别生成完整 fixture 并完成词索引，truncate WAL 后保存快照。迁移 37 的快照用于较早提交，迁移 38 的快照含 slice 79 新增的 10k OCR chunk，用于该提交及后续提交；每点复制快照，再运行该提交自身的迁移和 `ANALYZE`。

先测区间中点 `b39a8b5`，再核对三个候选提交及其两侧。起点也超过预算，无法用 500 ms 稳定区分 good/bad；本区间未找到可证明引入回归的提交。

| 提交      |  AROUND 三轮中位数（ms） | 一分钟负载范围 |
| --------- | -----------------------: | -------------: |
| `1b7a975` | 472.56 / 535.39 / 416.41 |     9.69–10.35 |
| `b39a8b5` | 556.33 / 482.89 / 517.36 |     9.44–10.20 |
| `3d1cd3f` | 567.97 / 566.34 / 586.03 |      7.80–7.95 |
| `cea6d24` | 648.79 / 557.77 / 512.90 |      9.27–9.46 |
| `450894d` | 650.22 / 575.99 / 529.56 |      9.04–9.59 |
| `81b69ee` | 471.47 / 531.91 / 520.67 |      8.21–8.34 |
| `6c04688` | 519.87 / 576.53 / 616.87 |      7.41–7.65 |

所有点的 AROUND 主查询都物化全部匹配消息，再按会话分组、建自动索引和排序，最后才取 50 个结果。该路径始于 `6fab95b`，在 `7fbce29` 移入 `store-threads.ts`；`1b7a975` 将零距离编译为 FTS 短语后仍保留这条全库聚合路径。slice 79 的迁移 38 只使参与者子查询改用覆盖索引；新增的摘要与排名在单独剖析中合计不到 10 ms。slice 86 的分类过滤不作用于这个无分类条件的搜索，迁移 39 只重置 Outlook 同步状态。slice 88 的徽标查询不在过滤测量内，迁移 40 的写入触发器不在只读查询中执行。轮次波动大于候选提交间的稳定差异，负载数据不足以单独归因。

修复让零距离 AROUND 使用现有日期分页路径：FTS 验证短语，按索引排除同会话的较旧匹配，取得有界结果页后再读取摘要与参与者。非零距离的后续优化见下节。计划断言要求零距离使用全局日期与会话日期索引，只物化 `page`，没有 `MATERIALIZE matches`、词位置读取或 GROUP BY 临时排序；旧实现已触发断言失败。行为测试覆盖有序／无序短语、带前导零的距离、同日 ID 分页、较新的不匹配回复，以及匹配消息的未读／星标聚合。

以下比较使用同一份迁移 38 快照，在相同 `6c04688` 代码上先运行原实现，再运行修复。每格为三轮中位数，括号为该轮最大值，单位 ms。预算仍为 500 ms，目标为不超过 400 ms。

| 实现   |                         AROUND 三轮中位数（最大值） | 一分钟负载范围 |
| ------ | --------------------------------------------------: | -------------: |
| 修复前 | 588.83 (683.79) / 552.89 (643.73) / 516.34 (829.30) |      8.35–8.79 |
| 修复后 |       87.25 (88.37) / 86.68 (90.08) / 86.19 (87.29) |      7.84–7.84 |

独立逐步骤剖析的总中位数为 455.22 → 89.74 ms，主 SQL 为 445.19 → 79.55 ms；摘要与排名没有出现同等幅度的变化。结果保留日期与 ID 顺序、匹配消息的标志聚合和附件命中语义，未修改预算、迁移或索引。

## 非零距离 AROUND 分页

Slice 90 新增 `search AROUND 3`，调用 `listThreads({ search: "alpha AROUND 3 beta", limit: 50 })`。这些词来自 100k fixture 的消息文本。先按日期索引取一个最多 50 个会话或消息的未搜索窗口。FTS NEAR 和位置检查只处理这个窗口。精确位置检查和未读／星标聚合只物化该窗口的消息。词位置虚表仍按词读取实例流，但仅保留窗口内位置。FTS 范围用 `(rowid+0) IN (...)`，避免每封候选消息重开 MATCH 游标。首个窗口没有精确命中或仍不能确定整页时，丢弃局部结果，以原查询和原游标执行一次旧全库路径。该上限也约束深页游标的前缀重放；计数保留全库路径。

NEAR 可能命中顺序或重叠不符的较新回复，因此精确会话头可能较旧。分页保留这些会话，并在下一候选头早于当前结果页尾时停止；调用方游标在精确头解析后应用。否定的 AROUND 分支不能直接否定 NEAR 超集，留给窗口内的精确检查。索引未就绪仍走原 AND 回退，不写索引。`around-pages.test.ts` 用三个随机种子对照直接扫描 fixture 文本的参考实现，不调用 Store 的 SQL 条件生成器，覆盖有序／无序、短语、重复词、布尔组合、分块、四种索引就绪状态、账户与文件夹范围、匹配头、标志、Unicode ID 并列和游标；`performance-plans.test.ts` 检查候选日期索引、窗口内消息 ID 检索及共享 MATCH 游标。

2026-10-07，在同一份临时 100k fixture 上串行比较 `71c9c0c` 的线程查询与修复版本。Node v24.21.0，默认 Node 堆上限，8 MiB SQLite 页缓存；正式预算套件仍使用 192 MiB 堆上限。每轮预热一次，取五次热运行中位数；查询计划和 fixture 生成不计时。负载在每轮结束时读取，列序为一／五／十五分钟。

| 实现   | 轮次 | 中位数 ms | 负载均值                |
| ------ | ---: | --------: | ----------------------- |
| 修复前 |    1 |    851.98 | 21.93 / 124.83 / 211.39 |
| 修复前 |    2 |    889.21 | 20.25 / 121.08 / 209.05 |
| 修复前 |    3 |    871.82 | 20.63 / 119.48 / 207.97 |
| 修复后 |    1 |    236.60 | 20.52 / 96.09 / 191.09  |
| 修复后 |    2 |    250.16 | 20.52 / 96.09 / 191.09  |
| 修复后 |    3 |    215.47 | 20.52 / 96.09 / 191.09  |

额外的 20k 和 100k 稀疏 fixture 包含每封邮件一个会话：除三封外，消息文本均为 `beta one alpha`，三封为 `alpha one beta`。有序 `"alpha AROUND 2 beta"` 的 NEAR 预筛选命中全库，精确匹配仅三封。预算套件分别验证会话、消息、否定查询的 500 ms 上限，以及第 40 页游标的 1500 ms 上限；结果写入 `/tmp/openmail-around-sparse-performance.json`，可用 `OPENMAIL_SPARSE_PERF_REPORT` 改路径。20k 报告另存为上述路径加 `.20000.json`。默认测试用 5000 封版本断言候选窗口实际执行不超过一次，同时核对三封结果和深页结果。该次数断言避免只依赖机器负载下的时延。

对首窗无命中回退的追加比较使用 `44ca8ff` 的旧线程查询。两种实现共用同一临时 SQLite 连接和 fixture，192 MiB Node 堆、8 MiB SQLite 缓存。预热后交替执行新旧查询各 15 次，取中位数；每个用例先比较完整返回对象。简单 AROUND 的 ASCII 窗口且没有派生块时，可用与 unicode61 相同的词边界排除整个窗口，省去额外实例流扫描；Unicode、派生块、布尔组合和未完成索引保留 SQLite 检查。单消息会话候选全部落在游标排除范围时直接回退；垃圾邮件资格读取已由触发器维护的 `message_search_meta.eligible`。原查询和游标保持不变。

| 规模 | 用例        | 旧路径 ms | 新路径 ms | 负载一／五／十五分钟  |
| ---: | ----------- | --------: | --------: | --------------------- |
|  20k | sparse      |     51.64 |     46.04 | 17.24 / 21.76 / 29.96 |
|  20k | sparse flat |     52.59 |     46.23 | 16.42 / 21.52 / 29.83 |
|  20k | negated     |     55.78 |     50.41 | 16.42 / 21.52 / 29.83 |
|  20k | deep        |    125.94 |    122.68 | 16.39 / 21.43 / 29.75 |
| 100k | sparse      |    301.15 |    267.33 | 15.18 / 21.00 / 29.50 |
| 100k | sparse flat |    292.80 |    259.05 | 14.15 / 20.59 / 29.25 |
| 100k | negated     |    321.75 |    294.79 | 16.18 / 20.71 / 29.14 |
| 100k | deep        |    759.10 |    705.08 | 19.49 / 21.00 / 29.00 |

所有用例的新路径中位数均低于旧路径。

三轮中位数从 871.82 ms 降至 236.60 ms，预算设为 475 ms，约为修复后中位数的两倍，低于 500 ms 上限。更早的一轮基线在负载 191.77 / 184.53 / 183.37 下测得 3121.36 ms；不将该轮作为同负载比较。完整测量仍用 `pnpm test:perf`；只复现该项可用：

```sh
OPENMAIL_PERF_MEASURE="search AROUND 3" OPENMAIL_PERF_REPORT=/tmp/openmail-around3.json pnpm test:perf
```

## 同步时的主线程阻塞（slice 97）

原因：真实 Outlook 首次同步（3,787 封 HTML）的前 60 s 里，主进程最长阻塞 670 ms。provider 解析在主线程调用 `htmlToText`，合计 37.9 s；每批写入事务含 200 条变更，在主线程一次跑完，真实库每事务 100 封时 CPU 最长 509 ms。

修复：HTML 提取改走 `HtmlText` 服务，Node 用 worker 池（见[平台清单](platform-inventory.md)），真实库 3,799 封的输出与当前线程逐字节相同；`WRITE_BATCH` 降到 20 条变更，事务之间让出事件循环，每事务 10 封时 CPU 最长 104 ms。批次边界原本就按时间切，Cursor 仍只与之前的全部变更一起提交。

`sync-performance.test.ts`（`test:perf`）经 Node worker 池和磁盘 WAL 数据库同步 2,000 封 HTML，断言 p99 阻塞低于 50 ms、最长阻塞低于 300 ms，负载低于 CPU 数时还要求没有超过 50 ms 的阻塞。三轮中位数（2026-10-08，串行，一分钟负载 36–52；修复前为当前线程提取加 200 条批次）：

| 实现   | 同步耗时 s | 最长阻塞 ms | p99 阻塞 ms | 超过 50 ms 的阻塞 |
| ------ | ---------: | ----------: | ----------: | ----------------: |
| 修复前 |       37.1 |         527 |         387 |               241 |
| 修复后 |       17.3 |          48 |         7.8 |                 0 |

## 写入与磁盘成本

```sh
pnpm --filter @openmail/core build
OPENMAIL_PERF=1 OPENMAIL_PERF_BASELINE_REF=dfe3a46 pnpm perf:cost
```

脚本使用真实 Store 写入同一份 10 万封快照，并比较历史 schema 与当前索引。生产设置为 WAL、FULL 同步、1000 页自动 checkpoint、8 MiB WAL 保留上限及页缓存。写入取五次热运行中位数，计时包含提交；未变 upsert 必须满足 `total_changes()=0`。写入回退超过 25% 或相同阶段 DB+WAL 增长超过 15% 时失败。空间同时记录提交后及 truncate 后的 DB+WAL。

## 条件与复现

合成数据库运行真实迁移，通过 `Store.upsertMessage` 写入 150,000 封邮件、3 个账户、50,001 个会话、20 个自定义标签、3,000 个公司／联系人快照和 15,000 项附件元数据。包含两个 FTS 索引、往来及服务端联系人候选、1,000 条邀请响应、1,500 条邀请历史和提醒。消息文本与 HTML 约 1 KiB。SQLite 页缓存 8 MiB，Node 堆上限 192 MiB。

SQL 基准为 main `1434a8b`，含迁移 26。读取取五次热运行中位数，写入取三次中位数；完整缓存清理只测一次。查询计划来自真实 Store SQL，单独采集，不计入读写时间。

```sh
pnpm --filter @openmail/core build
OPENMAIL_LOW_MEMORY_TESTS=1 OPENMAIL_PERF_BASELINE_REF=1434a8b node --expose-gc --max-old-space-size=192 packages/core/scripts/performance.mjs /tmp/openmail-before.json
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc --max-old-space-size=192 packages/core/scripts/performance.mjs /tmp/openmail-after.json
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc packages/core/scripts/sync-memory.mjs
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc packages/core/scripts/idle-memory.mjs
```

JSON 报告包含实际 SQL 和 `EXPLAIN QUERY PLAN`；脚本结束时清理临时数据库。

## 内存与启动

IMAP 通过 ImapFlow iterator 逐封解析并控制消费速度，批次保留元数据和消息文本，不累计全部原始 MIME 与附件字节。内存支架在模拟响应间执行 GC，区分保留对象与 GC 调度。Outlook 每次保留一个 50 封 delta 页、六个并发转换和最多 16 个事件；跨页仅保留 ID。回归覆盖顺序、移动优先于删除及最终检查点，任一页或重启失败时不清掉旧缓存。core 每批最多提交 200 个事件。

拼写菜单的 Set 在窗口关闭时移除监听器与闭包。原始 MIME 和会话查询的闲置 TTL 为零，读者卸载后释放；内嵌与派生图片保留两分钟。内存附件 LRU 上限 16 MiB、八封邮件，附件树按请求管理。持久磁盘附件缓存是另一层，容量与清理见[发布说明](release.md#old-mail-and-cache)。

迁移和恢复检查在 core 就绪前完成。Vision 版本检查、搜索回填、媒体／语义批次与初次自动同步等任一窗口 `ready-to-show` 后启动。Node 测试验证首窗口关闭后第二窗口仍可释放等待，以及监听器清理。Electron 实测见下一节。Apple Contacts 的进程内快照和清理限制见 [Apple Contacts](apple-contacts.md)，通用验证入口见[测试](testing.md)。

### 桌面冷启动与内存实测（slice 102）

真实邮箱只读副本：4,065 封邮件，2 个账户，数据库 238 MB。启动命令为 `OPENMAIL_READ_ONLY=1 electron-vite preview`，改动前后的构建交替冷启动，各 7 次取中位数，系统负载 8–12。基线为 `fc49dd3`。时间从 Electron 主进程启动算起，单位 ms。主进程和 renderer 的临时 performance mark 及 RPC 日志只在测量时加入，未提交。未打包的启动多一次约 70 ms 的 Dock 图标设置，前后两组都包含。

| 指标                          |  改动前 |  改动后 |
| ----------------------------- | ------: | ------: |
| 主进程模块求值完成            |     479 |     456 |
| 主窗口 `ready-to-show`        |     944 |     852 |
| renderer 起点到入口脚本执行完 |     211 |     130 |
| 首批列表行绘制                |    1098 |    1009 |
| 启动时 `Threads` 请求次数     |       3 |       1 |
| `Labels` RPC                  |   44–56 |       4 |
| renderer 入口块（未压缩）     | 4.20 MB | 4.01 MB |

改动如下：

- `listLabels` 的 Outlook 分类查询原先按 `messages_body_sizes` 扫描每行邮件，读取 `labels_json` 时要越过正文溢出页。查询现改用覆盖索引 `messages_thread_labels`（迁移 46 起为 `messages_thread_state`，user_version 46），耗时从 58 ms 降到 2 ms。它在首屏前执行，主线程 SQLite 串行，后续 RPC 原先都排在它后面。一次冷启动测到 1.4 s。`performance-plans.test.ts` 断言该计划。
- 首次同步 2,000 封 HTML Outlook 邮件时，事件循环最长阻塞原先在 62 ms 到 1.27 s 之间（5 次，负载 11–14）。阻塞来自两条同步 SQL：重置候选查询读 `labels_json` 和 `rfc_message_id`，同步健康检查读 `labels_json` 和 `is_unread`。这些列排在正文列之后，按行读取要走完每封邮件的正文溢出页，冷缓存下一次查询最长 1.27 s。迁移 46（user_version 46）把同步健康检查和 `listLabels` 改到覆盖索引 `messages_thread_state`，`messages_account_date` 加上 `provider_id`。重置候选先从索引列出标识，只为真正的候选读整行。改后 5 次最长阻塞 25–61 ms，p95 事件循环延迟 2.6–3.2 ms。这组数在负载 33–43 下测得（16 核），测试报告见 `sync-performance.test.ts`。
- 同步的写事务原先每次最多 20 条变更。20 封约 105 KB 的 HTML 邮件连同 FTS 和 `search_flags` 触发器在一次提交里写完，负载高时单次阻塞超过 50 ms。`mailbox-sync.ts` 现在还按正文大小切分，每个事务约 200 KB 正文，事务之间 `Effect.yieldNow`。改后 `pnpm test:perf` 跑 3 次，最长阻塞 33、19、29 ms，p99 9.1、8.2、7.8 ms，没有超过 50 ms 的阻塞，1 分钟负载 8.4、10.8、9.3（16 核）。`blocksOver50Ms` 断言只在 1 分钟负载低于核数一半时生效。
- `pagedList` 原先由 `Atom.family` 返回包装对象。family 只弱引用成员，GC 回收包装对象后，下一次读取会新建列表 atom，从第一页重新请求。启动时因此发出三次相同的 `Threads`。旧 atom 带着已加载的页保留 5 分钟闲置 TTL。现在每个 family 直接返回 atom，`threads-paging.test.ts` 在 GC 后检查挂载中的列表不变。
- `electron-updater` 的 GitHub provider 改为首次检查更新时加载。主进程启动时加载约 1,100 个 ES 模块。Node compile cache 曾使模块求值提前约 70 ms，因安全原因不启用，见[安全说明](security.md)。
- `openmail-app` 协议开启 `codeCache`。Chromium 第二次加载生成入口脚本的字节码缓存，第三次启动起使用。新构建的前两次启动仍约 211 ms。
- core 声明 `"sideEffects": false`。ical.js 在导入时执行代码，原先经 schema 入口被打进 renderer。`bundle-split.test.ts` 检查构建产物：入口不含 ical.js 和语言目录，按需页面各自成块。

改动前主进程 CPU profile 中，`ready` 前约 680 ms 用于 ESM 加载、编译和实例化；BrowserWindow 创建约 100 ms，在原生代码中。改动后首批列表行的关键路径主要是 renderer 首次渲染约 150 ms，主进程响应启动 RPC 均在 10 ms 内。renderer 开启压缩后入口为 1.97 MB，有字节码缓存时启动时间无可测差异，因此未启用。

内存在启动后闲置 2 分钟、再依次打开会话后测量。JS 堆在 GC 后读取，RSS 来自 `ps`，单位 MB。改动前后交替各测两次，基线为 `d5dd012`，数值范围相同，合并列出：

| 时点           | 主进程 RSS | 主进程堆 | renderer RSS | renderer 堆 |
| -------------- | ---------: | -------: | -----------: | ----------: |
| 闲置 2 分钟    |    288–293 |    44–46 |      185–223 |       15–19 |
| 打开 20 个会话 |    299–311 |    46–51 |      281–296 |       20–26 |
| 打开 60 个会话 |    305–309 |    47–48 |      327–337 |       21–23 |
| 再闲置 150 秒  |    306–310 |    47–48 |      329–335 |       21–22 |

改动前另有 4 次带临时日志的测量，其中 2 次 renderer 堆在 20 到 60 个会话后到 40–50 MB，闲置后不回落，与 GC 时机触发的重复列表 atom 相符。改动后 3 次都不超过 26 MB。改动前还有 2 次 renderer RSS 到 0.9 GB，JS 堆仍为 23–29 MB，原因未查明，改动后未出现。

DOM 节点、文档数和事件监听器在打开 40 个会话后不增长。renderer RSS 随打开的会话上升，增长不在 JS 堆中，推测来自 Blink 的布局和图片解码。`messageBackgroundAtom` 与 `imagesLoadedAtom` 原先按会话保留每封打开过的邮件或会话一项，直到窗口关闭，slice 105 已加上限。

### 主进程懒加载与阅读器拆块（slice 105）

方法同上一节：同一份真实邮箱只读副本（`.backup` 后由当前迁移升级），改动前后的构建交替冷启动各 7 次取中位数，系统负载 9–28。基线为 `6315d39`。模块数由 `--inspect-brk` 下的 `Debugger.scriptParsed` 计到 `ready-to-show`。时间单位 ms。

| 指标                          |  改动前 |  改动后 |
| ----------------------------- | ------: | ------: |
| 主进程 ES 模块（到窗口就绪）  |   1,069 |     796 |
| 主进程模块求值完成            |     465 |     389 |
| 主窗口 `ready-to-show`        |     867 |     761 |
| renderer 起点到入口脚本执行完 |     132 |     113 |
| 首批列表行绘制                |    1020 |     927 |
| renderer 入口块（未压缩）     | 4.01 MB | 2.99 MB |

- core 在首次使用时加载 imapflow、nodemailer（SMTP 与 MailComposer）、mailparser 和 `@effect/ai-anthropic`。动态导入失败映射为原操作的错误：IMAP 连接和 SMTP transport 为 `failure()` 的 ProviderError，MIME 构建为 PermanentError，解析为 “Cannot parse MIME message”，AI 请求为原有 ProviderError。semver 改为按函数子路径导入，从 47 个模块降到 10 个。PDF 和模型推理原本就在 worker 中。markdown-it（约 70 个模块，单独导入约 18 ms）仍随启动加载，`renderMarkdown` 及草稿指纹是同步的可移植接口，改成异步要改 drafts 解析和发送路径。
- renderer 的 `MessageBody` 块包含正文、远程图片提示、追踪器徽章和引用折叠。块加载前显示与 EmailFrame 初始高度（120 px）相同的占位框；判断远程内容需要解析器，提示在块加载后出现。iframe 的 sandbox 与 CSP 未改。块加载失败时正文位置显示“Couldn't load this message.”和 Retry，失败结果不缓存，Retry 重新导入。附件内嵌邮件和导入预览经 `LazyEmailFrame` 使用同一块。入口里的撰写代码经 `draft-loader.ts` 动态加载 `draft.ts`。`applyComposeSignature` 从 `signatures.ts` 移到 `compose-body.ts`：签名 schema 被 RPC 定义引用，原先把整套清理代码带进入口。`bundle-split.test.ts` 断言入口不含 `sanitizeReaderHtml` 和 DOMPurify。
- `messageBackgroundAtom` 与 `imagesLoadedAtom` 的值存在一个保活的 Map 中，按最近设置的顺序分别保留 200 封邮件和 100 个会话；family 成员只做派生，不再常驻。主窗口同一时间只打开一个会话，打开中的会话的决定不会被挤出，除非在该会话内对超过 200 封邮件分别切换背景。`state/ui.test.ts` 覆盖保留、淘汰和刷新顺序。

## Renderer 构建

设置、撰写、编辑器、日历、原始邮件、反馈、账户及提议审批按需加载。执行 `pnpm build` 后检查 `apps/desktop/out/renderer` 的块大小。初始入口包含 Effect 0.86 MB、react-dom 0.65 MB、Base UI 0.61 MB。邮件正文、EmailFrame、DOMPurify 和 core 的 HTML 清理与可见文本代码（parse5、css-tree、entities）在 `MessageBody` 和共享块中，见下一节。tldts（约 0.18 MB）仍在入口，邮件头的发件人仿冒提示和链接确认要用它。

AROUND 回归在 `performance-store.test.ts`：5000 封邮件先完成后台词索引，再执行有序计数、无序计数和列表查询，三次查询合计须低于 3 秒。通过 [FTS5 NEAR](https://sqlite.org/fts5.html#fts5_near_queries) 预筛选候选，词位置 CTE 每条查询只读取一次。索引未就绪时请求只执行 AND 回退，不写入或回填索引；这是自动回归上限，不是实机界面时延保证。

## 本地缓存管理（T07）

消息文本预算与“openmail 占用上限”默认关闭。整库占用为 `page_count × page_size + WAL + 附件文件 + 恢复副本`，空闲页已包含在数据库内，不重复相加。界面分别显示消息文本、附件、索引及其他数据、空闲页、WAL、恢复副本。消息文本是 UTF-8 逻辑负载，索引及其他数据为使用页减去消息文本的估计值。Node 按实际数据库路径查询所在卷的 `statfs.bavail`，计入 `.corrupt-*`、`.recovery-*` 及其 WAL；跳过符号链接，同一 inode 的硬链接只计一次。恢复副本保留，不因预算自动删除。

有效消息文本预算取手动预算和自适应预算的较小值。自适应预算从当前消息文本大小减去整库超额或磁盘空间缺口的较大值，再抵扣已有可复用页，下限为零。空闲空间低于 `min(5 GiB, 卷容量 × 10%)` 且已启用增量回收时，即使两个手动预算都关闭也执行收紧，并显示提示。旧库未启用回收时不为低磁盘继续淘汰文本，提示先手动压缩；新库在建表前直接启用增量模式。星标、保留窗口内、永久保留标签、草稿、发件箱仍豁免，因此目标可能无法达到。首次后台检查在窗口就绪一分钟后执行，随后每小时或预算变更执行；空间不足时绕过文本预算的小时门控。同步或 flush 占锁时本次检查跳过，下次小时检查重试。

迁移 37 将 messages、contact_candidates、contact_organizations 的隐藏 rowid 固定为同值的 `INTEGER PRIMARY KEY`，保留原有索引、触发器及依赖行，不运行 VACUUM。core、op-sqlite、smoke、恢复和当前 schema 的测试 helper 共用迁移外键包装：重建事务前暂关外键，提交前检查外键完整性，退出时恢复原外键设置。新消息继续通过 `upsertMessage` 写入。

“立即压缩”取得同步和 flush 的互斥许可，再独占 SQL 连接并升级访问锁，CLI／MCP 的闲置共享锁也会返回 busy。独立 Node worker 用自己的 DatabaseSync 连接执行 VACUUM、增量回收及检查；主进程只等待结果，界面持续显示进行中状态。另以 BEGIN IMMEDIATE 探测未注册的 SQLite writer，SQLITE_BUSY／LOCKED 同样返回 busy。同步、flush、只读会话、无法保证 rowid 的表、FTS 内容错位均拒绝。首次检查磁盘暂存空间、完整 FTS 索引后，运行 `auto_vacuum=INCREMENTAL` 与一次完整 VACUUM；后续只运行 `incremental_vacuum`。UI 显示进行中和结果。自动淘汰后、空闲页达到 1 MiB 或 WAL 达到 8 MiB 的小时检查中，只在已经启用增量模式时按实际 freelist 回收全部空闲页，并执行 `wal_checkpoint(TRUNCATE)`；不会自动执行首次完整 VACUUM。首次压缩前的空闲页仍占文件空间，目标可能需要手动压缩才能达到。

`platform/node/cache-management.test.ts` 覆盖计量、低磁盘 LRU 与所有豁免、旧库稀疏 rowid 迁移、压缩前后 FTS 搜索与依赖行、同步／flush 互斥、只读和不安全 rowid 拒绝。手机 CacheStorage 默认适配器返回空磁盘统计和零 WAL／恢复副本；不执行低磁盘收紧，详见[手机端说明](../apps/mobile/README.md)。未启动 Electron，未测量实机压缩耗时。整库统计读取 `body_cache_budget.total_bytes`，界面按一分钟或窗口 focus 刷新，线程变更不触发目录扫描。字节数使用各语言的 Intl 长单位复数格式，GB 使用独立单位。

迁移 37 的测量先建出 schema 36 的数据库，再用只含 schema 36 列的 SQL 写入 100k fixture 的消息和 10,000 个 OCR chunk。当前 Store 会查询之后才加的列，所以不经过 Store；schema 36 的触发器照常填 FTS、词表、搜索元数据和联系人候选。消息 rowid 为 `3i + 7`，带空隙。测试接着按顺序运行迁移 37 及之后的全部迁移，只计迁移 37 的时间，然后检查 rowid 未变、外键完整、FTS integrity-check 通过，耗时须低于 12,000 ms × `OPENMAIL_PERF_FACTOR` × max(1, 校准比)。2026-10-16 在 16 核 Mac 上运行两次，一分钟负载 4.7–11：3,407.6 ms（校准比 0.87）和 4,368.7 ms（校准比 0.96），升级前逻辑数据库 580,440,064 字节，Node v24.21.0、8 MiB 页缓存、FULL 同步。给迁移 37 加一段多耗约 12 s 的 SQL 时测试超出预算失败；复制 messages 时不带 rowid 时，rowid 检查失败。该重建也移到 worker；桌面在启动 worker 前绘制“正在升级本地数据库…”窗口，完成或失败后关闭。升级期间的 `window-all-closed` 保活监听器一直保留到 DesktopLive 注册正常关闭逻辑并创建主窗口，手动关闭升级窗口不会退出或取消迁移。已提交升级的 WAL truncate 如因读事务 busy 而延后，只记录警告并继续启动，不重复迁移。预检要求数据卷空闲至少为数据库逻辑大小，不满足时不执行重建并提示释放空间。worker 再检查一次，防止预检后的空间变化。手机的 op-sqlite 使用同一外键包装和原生异步 SQL，但未接入卷空间预检或完整 VACUUM worker；完整压缩明确返回 unavailable。

```sh
OPENMAIL_PERF=1 OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/core exec vitest run src/platform/node/migration37-performance.test.ts
# 报告默认 /tmp/openmail-migration37-performance.json，可设 OPENMAIL_MIGRATION_REPORT。
```

修正回归包含 FK-on smoke／手机升级保留依赖表、重复压力检查抵扣空闲页、未开启回收时不继续删除、worker 禁止调用方线程执行 VACUUM、心跳响应、真实子进程 CLI 共享锁、直接 SQLite writer、升级空间不足保留数据库字节，以及十种语言的字节复数。
