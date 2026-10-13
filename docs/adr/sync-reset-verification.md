# 验证同步重置的删除候选

状态：已采纳。

## 背景

协调器在只读真实数据副本上运行 sync-health，得到以下结果：

| Outlook 文件夹 |              服务端消息 |                  本地消息 |
| -------------- | ----------------------: | ------------------------: |
| Inbox          | 28,666，其中未读 26,042 | 重启前 1,199，重列举约 91 |
| Sent           |                      98 |                        65 |
| Archive        |                     103 |                        52 |

410 重启后的缺失不能解释为服务端 Inbox 缩小。已确认的客户端错误是：把未证明完整的 delta 列举当作整个文件夹的 keep 集合，清理约 1,100 条本地消息；源码还允许在没有 nextLink 或 deltaLink 时结束，并在缺少 conversationId 的单项 GET 返回 404 后漏记 listed ID。旧 Outlook 循环没有 90 天或 2,000 条截断，也没有日期过滤。当前实现明确限定日期范围，将每个列出的 ID 立即加入 keep，失败的完整读取稍后补取，并验证窗口内缺失项。

协调器随后在只读真实数据副本上验证 `532b888`：Outlook 保留 1,479 条，没有大规模删除。新诊断显示，410 重启后 Inbox 的 listing 阶段 `listed:50, kept:50`，reset 阶段全局 keep 为 53，文件夹范围内本地有 512 条。50 与旧初始 delta URL 的 `$top=50` 一致；这次观测中 Graph 把 `$top` 用作本轮上限，在 50 条后直接返回 deltaLink，没有 nextLink，适配器因而停止枚举。

根因修复将页大小移到 `odata.maxpagesize` 请求头，并从 delta 请求 URL 删除 `$top`，包括旧游标中的显式参数。回归假 Graph 在有 `$top` 时复现“50 条后结束”，改用请求头后按 50、50、23 分页交付全部 123 条；初始同步、410 重启、续页和下一轮增量都检查请求头与 ImmutableId 设置。窗口范围、5,000 条过滤上限的保护、逐项验证和持久续验继续生效。已有 28,666 条服务端计数、1,199 条窗内缓存与 91 条列举的回归仍通过 `syncHealth` 检查本地保留，并覆盖窗外邮件、UID 复用、移动和失败。

重试与发送确认实现见 [provider-retry.ts](../../packages/core/src/providers/provider-retry.ts)、[Gmail](../../packages/core/src/providers/gmail/gmail.ts)、[Outlook](../../packages/core/src/providers/outlook/outlook.ts)和 [mailbox-live.ts](../../packages/core/src/mailbox/mailbox-live.ts)。UID 重置与发送回归见 [uid-remap.test.ts](../../packages/core/src/mailbox/uid-remap.test.ts)及 [store.test.ts](../../packages/core/src/store/store.test.ts)。

## 决定与影响

不把未证明完整的服务端列举当作删除依据。删除候选进入持久验证队列，确认不存在后再删除。Graph 页大小通过请求头设置；失败及未验证项保留缓存。当前同步规则见[同步说明](../sync-correctness.md#重置删除保护)。
