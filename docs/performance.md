# 性能

真实邮件缓存副本的内容脱敏检查见 [corpus-check](corpus-check.md)。

本页维护本地性能预算及复现命令。使用 Node 和 `node:sqlite`，不测量 Electron、模型下载或真实账户端到端时延。

## 10 万封邮件预算

运行真实迁移和 `Store.upsertMessage`，临时数据库包含 100,000 封邮件、3 个账户、200 个标签／文件夹、20,000 个会话，其中 100 个长会话各有 204 封邮件。消息文本含 CJK 和引用历史，HTML 使用仓库中的 newsletter、Outlook Word fixture；独立解析测试输入为 200 KiB UTF-8，含内联 CSS、隐藏内容和 JSON-LD 事件。数据库生成在系统临时目录，Layer 关闭后删除。SQLite 页缓存 8 MiB，Node 堆上限 192 MiB；Effect 时钟固定为 2026-10-03，缓存窗口不受测试运行日期影响。

```sh
OPENMAIL_PERF=1 pnpm test:perf
# 可指定完整 SQL、查询计划和测量结果的输出位置：
OPENMAIL_PERF=1 OPENMAIL_PERF_REPORT=/tmp/openmail-performance.json pnpm test:perf
```

大数据套件是 `packages/core/src/platform/node/performance-large.test.ts`，默认 `pnpm test` 排除它。默认套件中的 `performance-plans.test.ts` 集中检查真实 Store 查询。同步健康与分页用例只写 120 封邮件；联系人用例保留原有候选规模。它们检查索引使用、分页回绕、孤立草稿去重和 Unicode ID 顺序。150k 迁移用例仅在 `OPENMAIL_PERF=1` 时执行。MCP 测量调用真实 Toolkit handler 与 Mailbox，provider 使用进程内 fake，不发网络请求。

`pnpm test:perf` 也运行 `visible-text-cost.test.ts`。日常套件的计时规则见[负载下的测试](testing.md#负载下的测试)。

每项先执行一次并单独采集 `EXPLAIN QUERY PLAN`，再取五次热运行中位数；remap、invalidate 和实际淘汰取三次。写入每次在事务末尾回滚，重复测量使用相同状态。断言中位数低于下表预算，JSON 同时保留各次时延、最大值和测量结束时的一／五／十五分钟负载。fixture 生成、查询计划采集及索引完整性检查不计入时延。

| 路径                                   | 预算 ms |
| -------------------------------------- | ------: |
| provider ID 不命中查找                 |       5 |
| sync-health 标签本地计数／观察标签     |     150 |
| sync-health IMAP 本地计数              |     100 |
| stale sweep 标签／IMAP 的 100 条候选页 |     100 |
| stale sweep claim 与游标保存           |      25 |
| reset 账户七日窗口                     |     200 |
| reset 标签／IMAP 三十日窗口            |     150 |
| reset 候选持久化                       |      50 |
| 未读账户／标签徽标                     |     100 |
| list_threads 首页 50 个会话            |      75 |
| 常见词／CJK／运算符搜索，50 个会话     |     150 |
| has:drive／has:spreadsheet，50 个会话  |      50 |
| 消息文本＋OCR 搜索，200 个会话         |     100 |
| OCR 摘要搜索，50 个会话                |     150 |
| AROUND 0 搜索，50 个会话               |     500 |
| AROUND 3 搜索，50 个会话               |     475 |
| AROUND 精确命中稀疏，100k 消息         |     500 |
| AROUND 深页游标，100k 会话             |    1500 |
| getThread，204 封长会话                |     100 |
| 长会话模型文本                         |     500 |
| 200 KiB HTML 可见文本                  |     150 |
| 200 KiB HTML 清洗                      |     200 |
| 200 KiB 结构化事件检测                 |     100 |
| MCP list_threads／search               |     200 |
| remap 100 个身份                       |     250 |
| invalidate IMAP 文件夹                 |     500 |
| 各账户消息文本字节数                   |     150 |
| 消息文本预算全保护扫描                 |    5000 |
| 消息文本预算淘汰 1 MiB                 |     500 |
| 消息文本预算小时门控                   |      25 |

MCP 测量先为三个 fixture 账户打开 AI 权限，并断言 list_threads 和 search 都返回会话。此前没有授权，两项都返回空结果，测得 0.3 ms；授权后中位数约为 16 ms 和 75 ms。

fixture 中千分之一的邮件含 Google Sheet 链接，has:drive 和 has:spreadsheet 都要跳过大量不匹配行。迁移 45 在 `message_search_meta.search_flags` 记录 Drive 链接、附件类型和 `cid:` 内联图片，写入消息时由触发器计算；迁移前的行为 NULL，后台按批回填，查询只对这些行扫描消息文本和附件清单。改动前 has:drive 中位数 161 ms，has:spreadsheet 3021 ms；改动后分别约 12 ms 和 4 ms。附件类型规则冻结在 `SEARCH_FLAG_ATTACHMENT_TYPES_45`，测试要求它与 `ATTACHMENT_TYPES` 相同，规则变化须追加迁移。

预算淘汰测试将 INBOX 保留窗口设为 30 天，并断言实际淘汰了消息文本。小时门控测试在一次检查后再次调用；两者均回滚。完整预算扫描仍允许保留星标、草稿和无限窗口内的消息文本。

迁移 35 增加读取索引。扩展 provider ID 索引以覆盖 `ORDER BY date DESC,id`，避免不命中查找遍历整个账户；新增 IMAP 路径索引、远程草稿部分索引和消息文本字节数覆盖索引。索引定义已按下节的写入与空间验收缩减。stale sweep 从每个来源按 provider ID 取有界页，再按 SQLite BINARY 顺序合并；游标结束时回绕。日期分页使用覆盖元数据索引，先排除已有更近匹配的消息，再检查该行的全文条件。零距离 AROUND 按日期分页读取；非零距离先按日期读取 NEAR 候选窗口，只对窗口内消息计算词位置和分组；取得结果页后停止；最多两个候选窗口，超过后走全库查询。消息文本预算分页使用时间下界和 `(COALESCE(body_opened_at,date),id)` 继续定位，见 [SQLite 行值分页](https://www.sqlite.org/rowvalue.html#scrolling_window_queries)。索引维护增加写入和磁盘成本。

保留的扫描包括账户内标签 JSON、紧凑徽标投影、消息文本大小覆盖索引和 FTS 命中集合；它们不读取全部 HTML。reset 返回窗口内所有候选，`COUNT(DISTINCT thread_id)` 和已选长会话可使用临时排序。每条实际执行 SQL 的计划保存在临时 JSON；默认测试禁止裸扫大型 messages 表，并检查 stale 页没有全量 ORDER BY 排序。

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

拼写菜单的 Set 在窗口关闭时移除监听器与闭包。原始 MIME 和会话查询的闲置 TTL 为零，读者卸载后释放；内嵌与派生图片保留两分钟。内存附件 LRU 上限 16 MiB、八封邮件，附件树按请求管理。持久磁盘附件缓存是另一层，容量与清理见[发布说明](release.md#旧邮件与缓存)。

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

- `listLabels` 的 Outlook 分类查询原先按 `messages_body_sizes` 扫描每行邮件，读取 `labels_json` 时要越过正文溢出页。查询现改用覆盖索引 `messages_thread_labels`，耗时从 58 ms 降到 2 ms。它在首屏前执行，主线程 SQLite 串行，后续 RPC 原先都排在它后面。一次冷启动测到 1.4 s。`performance-plans.test.ts` 断言该计划。
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

迁移 37 在同一份 100k fixture 上测得 6,124.9 ms，升级前逻辑数据库 568,803,328 字节，Node v24.21.0、8 MiB 页缓存、FULL 同步。该重建也移到 worker；桌面在启动 worker 前绘制“正在升级本地数据库…”窗口，完成或失败后关闭。升级期间的 `window-all-closed` 保活监听器一直保留到 DesktopLive 注册正常关闭逻辑并创建主窗口，手动关闭升级窗口不会退出或取消迁移。已提交升级的 WAL truncate 如因读事务 busy 而延后，只记录警告并继续启动，不重复迁移。预检要求数据卷空闲至少为数据库逻辑大小，不满足时不执行重建并提示释放空间。worker 再检查一次，防止预检后的空间变化。手机的 op-sqlite 使用同一外键包装和原生异步 SQL，但未接入卷空间预检或完整 VACUUM worker；完整压缩明确返回 unavailable。

```sh
OPENMAIL_PERF=1 OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/core exec vitest run src/platform/node/migration37-performance.test.ts
# 报告默认 /tmp/openmail-migration37-performance.json，可设 OPENMAIL_MIGRATION_REPORT。
```

修正回归包含 FK-on smoke／手机升级保留依赖表、重复压力检查抵扣空闲页、未开启回收时不继续删除、worker 禁止调用方线程执行 VACUUM、心跳响应、真实子进程 CLI 共享锁、直接 SQLite writer、升级空间不足保留数据库字节，以及十种语言的字节复数。
