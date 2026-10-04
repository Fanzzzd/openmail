# 性能

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

迁移 35 增加读取索引，当前迁移版本为 36。扩展 provider ID 索引以覆盖 `ORDER BY date DESC,id`，避免不命中查找遍历整个账户；新增 IMAP 路径索引、远程草稿部分索引和消息文本字节数覆盖索引。索引定义已按下节的写入与空间验收缩减。stale sweep 从每个来源按 provider ID 取有界页，再按 SQLite BINARY 顺序合并；游标结束时回绕。日期分页使用覆盖元数据索引，先排除已有更近匹配的消息，再检查该行的全文条件。AROUND 一次生成匹配元数据，再分组读取选中的摘要。消息文本预算分页使用时间下界和 `(COALESCE(body_opened_at,date),id)` 继续定位，见 [SQLite 行值分页](https://www.sqlite.org/rowvalue.html#scrolling_window_queries)。索引维护增加写入和磁盘成本。

保留的扫描包括账户内标签 JSON、紧凑徽标投影、消息文本大小覆盖索引和 FTS 命中集合；它们不读取全部 HTML。reset 返回窗口内所有候选，`COUNT(DISTINCT thread_id)` 和已选长会话可使用临时排序。每条实际执行 SQL 的计划保存在临时 JSON；默认测试禁止裸扫大型 messages 表，并检查 stale 页没有全量 ORDER BY 排序。

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
