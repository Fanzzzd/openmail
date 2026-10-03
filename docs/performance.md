# 性能

本页分别记录 slice 61 的本地性能预算和 slice 36 的历史测量。两次测量均使用 Node v24.21.0 和 `node:sqlite`，未启动 Electron、模型下载或真实账户。以下数字不代表冷启动或端到端时延。

## Slice 61：10 万封邮件预算

运行真实迁移和 `Store.upsertMessage`，临时数据库包含 100,000 封邮件、3 个账户、200 个标签／文件夹、20,000 个会话，其中 100 个长会话各有 204 封邮件。消息文本含 CJK 和引用历史，HTML 使用仓库中的 newsletter、Outlook Word fixture；独立解析测试输入为 200 KiB UTF-8，含内联 CSS、隐藏内容和 JSON-LD 事件。数据库生成在系统临时目录，Layer 关闭后删除。SQLite 页缓存 8 MiB，Node 堆上限 192 MiB；Effect 时钟固定为 2026-10-03，缓存窗口不受测试运行日期影响。

```sh
OPENMAIL_PERF=1 pnpm test:perf
# 可指定完整 SQL、查询计划和测量结果的输出位置：
OPENMAIL_PERF=1 OPENMAIL_PERF_REPORT=/tmp/openmail-slice61-performance.json pnpm test:perf
```

大数据套件是 `packages/core/src/platform/node/performance-large.test.ts`，默认 `pnpm test` 排除它。默认套件中的 `performance-plans.test.ts` 只写 120 封邮件，采集真实 Store 查询，检查索引使用、分页回绕、孤立草稿去重和 Unicode ID 顺序。MCP 测量调用真实 Toolkit handler 与 Mailbox，provider 使用进程内 fake，不发网络请求。

每项先执行一次并单独采集 `EXPLAIN QUERY PLAN`，再取五次热运行中位数；remap、invalidate 和实际淘汰取三次。写入每次在事务末尾回滚，重复测量使用相同状态。断言中位数低于下表预算，JSON 同时保留最大值。fixture 生成、查询计划采集及索引完整性检查不计入时延。

2026-10-04 本机最终验证基于包含 slice 62 的 main `44538b8`，31 项均低于预算。实测列按路径列中各项的顺序排列。

| 路径                                   |               实测 ms | 预算 ms |
| -------------------------------------- | --------------------: | ------: |
| provider ID 不命中查找                 |                  0.01 |       5 |
| sync-health 标签本地计数／观察标签     |         99.01 / 10.78 |     150 |
| sync-health IMAP 本地计数              |                  0.57 |     100 |
| stale sweep 标签／IMAP 的 100 条候选页 |           0.66 / 0.34 |     100 |
| stale sweep claim 与游标保存           |                  0.11 |      25 |
| reset 账户七日窗口                     |                  4.83 |     200 |
| reset 标签／IMAP 三十日窗口            |           6.16 / 0.73 |     150 |
| reset 候选持久化                       |                  0.07 |      50 |
| 未读账户／标签徽标                     |          7.79 / 12.95 |     100 |
| list_threads 首页 50 个会话            |                 27.49 |      75 |
| 常见词／CJK／运算符搜索，50 个会话     | 65.01 / 81.15 / 20.85 |     150 |
| AROUND 搜索，50 个会话                 |                489.70 |     500 |
| getThread，204 封长会话                |                  2.70 |     100 |
| 长会话模型文本                         |                 92.26 |     500 |
| 200 KiB HTML 可见文本                  |                 17.69 |     150 |
| 200 KiB HTML 清洗                      |                 11.35 |     200 |
| 200 KiB 结构化事件检测                 |                  2.64 |     100 |
| MCP list_threads／search               |        31.16 / 106.16 |     200 |
| remap 100 个身份                       |                 20.41 |     250 |
| invalidate IMAP 文件夹                 |                130.08 |     500 |
| 各账户消息文本字节数                   |                  3.93 |     150 |
| 消息文本预算全保护扫描                 |                523.71 |    5000 |
| 消息文本预算淘汰 1 MiB                 |                 29.09 |     500 |
| 消息文本预算小时门控                   |                  0.14 |      25 |

预算淘汰测试将 INBOX 保留窗口设为 30 天，并断言实际淘汰了消息文本。小时门控测试在一次检查后再次调用；两者均回滚。完整预算扫描仍允许保留星标、草稿和无限窗口内的消息文本。

迁移 35 在 main 只有迁移 34 时追加，前 34 条未改。扩展 provider ID 索引以覆盖 `ORDER BY date DESC,id`，避免不命中查找遍历整个账户；新增 IMAP 路径索引、远程草稿部分索引和消息文本字节数覆盖索引。索引定义已按下节的写入与空间验收缩减。stale sweep 从每个来源按 provider ID 取有界页，再按 SQLite BINARY 顺序合并；游标结束时回绕。日期分页使用覆盖元数据索引，先排除已有更近匹配的消息，再检查该行的全文条件。AROUND 一次生成匹配元数据，再分组读取选中的摘要。消息文本预算分页使用时间下界和 `(COALESCE(body_opened_at,date),id)` 继续定位，见 [SQLite 行值分页](https://www.sqlite.org/rowvalue.html#scrolling_window_queries)。索引维护增加写入和磁盘成本。

保留的扫描包括账户内标签 JSON、紧凑徽标投影、消息文本大小覆盖索引和 FTS 命中集合；它们不读取全部 HTML。reset 返回窗口内所有候选，`COUNT(DISTINCT thread_id)` 和已选长会话可使用临时排序。每条实际执行 SQL 的计划保存在临时 JSON；默认测试禁止裸扫大型 messages 表，并检查 stale 页没有全量 ORDER BY 排序。

最终 fixture 生成用时 40.61 秒，测试进程末次采样 RSS 401.4 MiB、已用 JS 堆 68.5 MiB；这些值含 Vitest 和 SQLite，不是 Electron 内存。首轮已记录的常见词、CJK 和 AROUND 热查询中位数分别为 533.24、1032.39、873.68 ms；首轮在缓存扫描阶段达到 20 分钟上限，没有完整 JSON。最终完整报告写到 `/tmp/openmail-slice61-performance.json`，包含每项的 SQL、查询计划、中位数、最大值和预算。

## 迁移 35：写入与磁盘成本

基准固定为迁移 34 的 main `dfe3a46`，使用同一份 100,000 封 fixture 的副本比较修订后的迁移 35。两侧的 `upsertMessage`、`applyLocalOp` 和 provider ID 查找实现相同，脚本逐一比对 TypeScript AST。仅 schema／索引不同；Node 层不启用向量清理，不发网络请求。

```sh
pnpm --filter @openmail/core build
OPENMAIL_PERF=1 OPENMAIL_PERF_BASELINE_REF=dfe3a46 pnpm perf:cost
```

脚本先用真实 `Store.upsertMessage` 生成迁移 34 数据库。生成期间的临时 provider 查找索引随后删除，两侧统一执行 VACUUM、ANALYZE 和 truncate checkpoint；FTS 完整性检查确保 rowid 对齐。每个写入样本都从同一份 10 万封快照复制，完成一次真实事务提交，计时包含 commit 与自动 checkpoint；不使用回滚代替提交。每项先热身一次，再取五次中位数。未变 upsert 分散取样，并断言 `total_changes()=0`；标签修改也分散在三个账户中。

SQLite 使用生产设置：WAL、FULL 同步、1000 页自动 checkpoint、8 MiB WAL 保留上限，页缓存为 8 MiB。空间按逻辑文件长度统计 DB+WAL，分别记录迁移提交后、显式 truncate 后和每种写入后的状态；不把自动 checkpoint 后仍保留的 WAL 文件忽略。脚本在写入回退超过 25% 或任一相同阶段的 DB+WAL 增长超过 15% 时失败。

| 测量项                  | main／迁移 34 | 修订后迁移 35 |   变化 |
| ----------------------- | ------------: | ------------: | -----: |
| 同步写入 1,000 封新邮件 |     307.45 ms |     327.61 ms | +6.56% |
| 1,000 封未变 upsert     |      38.50 ms |      40.21 ms | +4.44% |
| 100 封邮件标签修改      |      56.53 ms |      52.97 ms | -6.30% |
| 10 万封库升级迁移 35    |             — |     450.06 ms |      — |
| 迁移提交后 DB+WAL       |    480.20 MiB |    527.15 MiB | +9.78% |
| 显式 truncate 后 DB+WAL |    480.20 MiB |    499.15 MiB | +3.95% |

原提交 `f6071e7` 在相同生产设置下，标签修改为 52.08 → 77.02 ms，回退 47.90%；迁移提交后 DB+WAL 为 480.20 → 596.10 MiB，增长 24.14%。因此删除 `messages_sync_metadata` 和 `messages_thread_summary`，IMAP 索引仅保留账户、路径表达式、provider ID 和日期；账户日期索引保持迁移 34 的定义。AROUND 复用全局日期覆盖索引。复测 31 项读取预算均通过，其中 AROUND 中位数为 489.70 ms，预算为 500 ms。只在全局日期索引中新增 `labels_json`；前 34 条迁移不变，尚未合并的迁移 35 随此次提交修订。

最终三种写入后的 DB+WAL 增长分别为 4.01%、3.95%、4.00%，均低于 15%。升级取三份独立副本的中位数，最大值为 498.15 ms。标签修改的负变化属于本机样本波动，不作为性能改进承诺。完整样本、DB/WAL 分项及索引页大小见 `/tmp/openmail-slice61-cost.json`；索引缩减后仍须通过上节的 31 项读取预算。

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

JSON 报告包含 SQL 和 `EXPLAIN QUERY PLAN`。历史 SQL 从 git 编译，不切换工作树；结束时清理临时数据库。历史运行跳过可能持续数分钟的宽范围 FTS 查询。常见词的旧查询在超过三分钟后终止；常见词计数与公司查询的旧值来自优化中间版本，N/A 表示没有基准。现在重跑的“修改后”使用当前构建，不能据此复写历史测量。

## 查询与写入

| 路径                 |      修改前 ms | 修改后 ms |
| -------------------- | -------------: | --------: |
| 标签首页             |           3.99 |      4.32 |
| 标签下一页           |           3.99 |      4.03 |
| 标签未读             |           1.64 |      1.77 |
| 标签单封视图         |           1.39 |      1.06 |
| 收件箱首页           |         395.29 |      1.24 |
| 会话计数             |         185.83 |     24.33 |
| 账户未读徽标         |         230.70 |     12.43 |
| 标签未读徽标         |         167.35 |     18.59 |
| 收件箱标签徽标       |         157.55 |     14.32 |
| FTS trigram          |           3.07 |      8.69 |
| 词索引搜索           |           2.93 |      5.89 |
| 词索引常见词         | >180000 (超时) |      6.18 |
| 常见词搜索计数       |         186.88 |     41.94 |
| trigram 常见词       |            N/A |     25.00 |
| Gmail 运算符         |          21.48 |     18.20 |
| 联系人前缀           |          35.32 |     25.99 |
| 空条件联系人         |         100.87 |     30.57 |
| 联系人公司           |          81.63 |     19.10 |
| 发件历史             |           0.08 |      0.08 |
| 邀请查询             |          67.66 |      0.01 |
| 提醒扫描             |           0.02 |      0.01 |
| 邀请响应查询         |           0.01 |      0.01 |
| 邀请历史缓存         |            N/A |      0.40 |
| 关联邀请邮件         |            N/A |      0.03 |
| 缓存候选             |          66.50 |      0.13 |
| 规则历史应用分页     |           0.87 |      0.60 |
| 缓存淘汰扫描         |           0.14 |      0.09 |
| 标签修改             |          16.93 |     19.87 |
| 同步 1000 封新邮件   |         326.11 |    381.33 |
| 同步 1000 封不变邮件 |         109.06 |     28.03 |
| 完整缓存清理         |        9680.99 |   1461.93 |

此次测量中的 UI 读取均小于 50 ms，仅指热数据库查询。标签修改操作 100 封邮件；同步分别写入 1,000 封新邮件和 1,000 封未变邮件。清理以 200 行分页扫描，清空 1,364 封过期消息文本。同步和清理在后台运行。

迁移 30 增加覆盖索引、徽标与搜索投影，移除已被替代的会话和未裁剪 RFC ID 索引。多账户列表按日期／ID 索引分页，不排序整张邮件表。投影减少徽标、联系人和搜索计数对 JSON 与 MIME 内容的读取。会话 FTS 查询按 rowid 探测，常见词用最多 2,049 个命中判断是否先按日期分页。联系人公司索引用姓名、地址、公司合成文档和前缀索引，contentless-delete 避免重复保存原字符串，见 [SQLite FTS5](https://sqlite.org/fts5.html#contentless_delete_tables)。未变化的 upsert 不执行 UPDATE，保留 rowid 与 FTS。

保留的扫描范围有界：日期分页到页上限停止，徽标与联系人计数扫描紧凑投影，FTS 扫描命中 rowid。参与者排序只处理选出的 50 个会话。查询计划回归覆盖未读计数、会话标签、provider ID、裁剪 RFC ID 和待推送操作。

并发打开数据库时，迁移锁冲突最多重试 120 秒；普通 SQL 保留五秒 busy timeout。两进程回归将迁移锁持有超过五秒。填充库升级单次用时 2.26 秒，数据库加 WAL 从 578.7 增至 677.6 MiB。维护投影使新插入增加 17% 时间，重复同步减少更新成本。这些值没有冷磁盘或真实网络测量。

## 内存与启动

| 测量项                                                 |    修改前 |   修改后 |
| ------------------------------------------------------ | --------: | -------: |
| IMAP 批次，25 封各含 4 MiB 附件，额外 ArrayBuffer 峰值 | 178.7 MiB | 28.0 MiB |
| 关闭 1,000 个窗口后保留的拼写清理闭包                  |     1,000 |        0 |
| 选择变化时渲染的可见列表行                             |        12 |        2 |

IMAP 通过 ImapFlow iterator 逐封解析并控制消费速度，批次保留元数据和消息文本，不累计全部原始 MIME 与附件字节。内存支架在模拟响应间执行 GC，区分保留对象与 GC 调度。Outlook 每次保留一个 50 封 delta 页、六个并发转换和最多 16 个事件；跨页仅保留 ID。回归覆盖顺序、移动优先于删除及最终检查点，任一页或重启失败时不清掉旧缓存。core 每批最多提交 200 个事件。

三条本地非 TLS IDLE 连接增加 779 KiB 堆。100／200／300 次连接关闭后保留 1,815／1,734／1,831 KiB，残留 socket 和消息监听器均为零。数据含库初始化，不含 TLS 与真实服务器开销。

拼写菜单的 Set 在窗口关闭时移除监听器与闭包。原始 MIME 和会话查询的闲置 TTL 为零，读者卸载后释放；内嵌与派生图片保留两分钟。内存附件 LRU 上限 16 MiB、八封邮件，附件树按请求管理。持久磁盘附件缓存是另一层，容量与清理见[发布说明](release.md#旧邮件与缓存)。

迁移和恢复检查在 core 就绪前完成。Vision 版本检查、搜索回填、媒体／语义批次与初次自动同步等任一窗口 `ready-to-show` 后启动。Node 测试验证首窗口关闭后第二窗口仍可释放等待，以及监听器清理。没有实测 Electron 首帧或 RSS；列表渲染计数来自 Node DOM。Apple Contacts 的进程内快照和清理限制见 [Apple Contacts](apple-contacts.md)，通用验证入口见[测试](testing.md)。

## Renderer 构建块

原初始入口为 3,301.19 kB JS，gzip 714.56 kB。下表来自性能切片构建，包含当时 AI 功能与按需语言目录。设置、撰写、编辑器、邀请／日历、原始邮件、反馈、账户／Profile 编辑和提议审批经局部 Suspense 按需加载。AI 快捷键／摘要控制器留在初始入口。

| 构建块            |      kB | gzip kB |
| ----------------- | ------: | ------: |
| index             | 2673.53 |  573.55 |
| Settings          |  223.19 |   42.73 |
| Composer          |  107.14 |   23.89 |
| ComposeEditor     |   95.24 |   22.63 |
| catalog (ru)      |   86.08 |   24.98 |
| ServerSettings    |   77.39 |   15.65 |
| catalog (ja)      |   66.90 |   22.52 |
| catalog (fr)      |   59.60 |   21.62 |
| catalog (de)      |   57.32 |   21.64 |
| catalog (it)      |   56.53 |   21.11 |
| catalog (es)      |   56.51 |   21.35 |
| catalog (cs)      |   55.07 |   21.92 |
| catalog (nl)      |   54.07 |   21.17 |
| catalog (en)      |   47.21 |   19.39 |
| catalog (zh-CN)   |   44.75 |   19.85 |
| SystemSettings    |   36.01 |    7.73 |
| InviteBanner      |   33.36 |    7.07 |
| AddAccountDialog  |   28.80 |    6.89 |
| Proposals         |   19.95 |    4.89 |
| ProfileEditor     |   15.73 |    4.17 |
| RadioGroup        |   12.75 |    3.32 |
| Feedback          |   10.60 |    2.84 |
| RawMessage        |    8.19 |    2.47 |
| SegmentedControl  |    3.64 |    1.45 |
| CreateLabelDialog |    2.13 |    0.89 |
| Button            |    0.72 |    0.35 |

数字来自 `out/renderer`，gzip 由 Python 计算。React、Effect／RPC／schema、Base UI 和邮件阅读代码仍在入口。拆分减少初始解析，安装字节总量仍包含所有块。重新构建后须重新测量，不能沿用表中的大小或哈希文件名。

AROUND 回归在 `performance-store.test.ts`：5000 封邮件先完成后台词索引，再执行有序计数、无序计数和列表查询，三次查询合计须低于 3 秒。通过 [FTS5 NEAR](https://sqlite.org/fts5.html#fts5_near_queries) 预筛选候选，词位置 CTE 每条查询只读取一次。索引未就绪时请求只执行 AND 回退，不写入或回填索引；这是自动回归上限，不是实机界面时延保证。
