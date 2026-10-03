# 性能

本页保留 slice 36 在本机的测量，使用 Node v24.21.0 和 `node:sqlite`。测量未启动 Electron、开发应用、安装包、模型下载或真实账户。后续切片未在本页重新测量，以下数字不代表当前构建的冷启动或端到端时延。

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
