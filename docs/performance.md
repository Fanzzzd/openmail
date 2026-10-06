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

每项先执行一次并单独采集 `EXPLAIN QUERY PLAN`，再取五次热运行中位数；remap、invalidate 和实际淘汰取三次。写入每次在事务末尾回滚，重复测量使用相同状态。断言中位数低于下表预算，JSON 同时保留最大值。fixture 生成、查询计划采集及索引完整性检查不计入时延。

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
| AROUND 搜索，50 个会话                 |     500 |
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

预算淘汰测试将 INBOX 保留窗口设为 30 天，并断言实际淘汰了消息文本。小时门控测试在一次检查后再次调用；两者均回滚。完整预算扫描仍允许保留星标、草稿和无限窗口内的消息文本。

迁移 35 增加读取索引，当前迁移版本为 37。扩展 provider ID 索引以覆盖 `ORDER BY date DESC,id`，避免不命中查找遍历整个账户；新增 IMAP 路径索引、远程草稿部分索引和消息文本字节数覆盖索引。索引定义已按下节的写入与空间验收缩减。stale sweep 从每个来源按 provider ID 取有界页，再按 SQLite BINARY 顺序合并；游标结束时回绕。日期分页使用覆盖元数据索引，先排除已有更近匹配的消息，再检查该行的全文条件。AROUND 一次生成匹配元数据，再分组读取选中的摘要。消息文本预算分页使用时间下界和 `(COALESCE(body_opened_at,date),id)` 继续定位，见 [SQLite 行值分页](https://www.sqlite.org/rowvalue.html#scrolling_window_queries)。索引维护增加写入和磁盘成本。

保留的扫描包括账户内标签 JSON、紧凑徽标投影、消息文本大小覆盖索引和 FTS 命中集合；它们不读取全部 HTML。reset 返回窗口内所有候选，`COUNT(DISTINCT thread_id)` 和已选长会话可使用临时排序。每条实际执行 SQL 的计划保存在临时 JSON；默认测试禁止裸扫大型 messages 表，并检查 stale 页没有全量 ORDER BY 排序。

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

迁移和恢复检查在 core 就绪前完成。Vision 版本检查、搜索回填、媒体／语义批次与初次自动同步等任一窗口 `ready-to-show` 后启动。Node 测试验证首窗口关闭后第二窗口仍可释放等待，以及监听器清理。没有实测 Electron 首帧或 RSS；列表渲染计数来自 Node DOM。Apple Contacts 的进程内快照和清理限制见 [Apple Contacts](apple-contacts.md)，通用验证入口见[测试](testing.md)。

## Renderer 构建

设置、撰写、编辑器、日历、原始邮件、反馈、账户及提议审批按需加载。执行 `pnpm build` 后检查 `apps/desktop/out/renderer` 的块大小；初始入口仍包含 React、Effect／RPC／schema、Base UI 和邮件阅读代码。

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
