# IMAP 两端会话 ID

状态：记录现状，建议统一；本次不改变算法。

## 算法与已知差异

Node 的 [threadIdOf](../../packages/core/src/platform/node/imap/parse.ts) 使用 MailCodec 解析后的 `references`、`inReplyTo`、`messageId`，按此顺序取第一个有效 ID。References 数组先用空格拼接。每个字段先匹配 `<([^<>\s]+)>`；没有匹配时，按空白切分，接受包含 `@` 的词。字段没有有效 ID 才继续回退，全部缺失时使用 providerId。

RN 的 [mobileIncoming](../../packages/core/src/platform/react-native/imap-parse.ts) 从 `headers` Map 读取字符串 References 和 Message-ID，以 `references || parsed.inReplyTo || messageId` 先选一个非空字段，再匹配 `<([^<>]+)>`。它不接受裸 ID，也不在匹配失败后试下一个字段；尖括号内的空白会被保留。非字符串 headers 值按空串处理。匹配失败时使用 providerId。

两端 MIME adapter 也影响输入：Node 用 mailparser，RN 用 postal-mime。[回归](../../packages/core/src/platform/node/imap-thread-ids.test.ts) 将以下原始邮件头分别交给真实 codec，固定当前结果。RN providerId 为 `9:1:INBOX`。

| 邮件头                                                                                        | Node threadId                                        | RN threadId |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------- |
| `Message-ID: bare@example.test`                                                               | `bare@example.test`                                  | `9:1:INBOX` |
| `Message-ID: <child@example.test>`，`References: root@example.test`                           | `root@example.test`                                  | `9:1:INBOX` |
| `Message-ID: <child@example.test>`，`References: noise`，`In-Reply-To: <parent@example.test>` | `noise`，Node codec 将 References 规范化成尖括号形式 | `9:1:INBOX` |

有效的标准引用链通常一致。另一个纯算法差异是：对尚未规范化的 `references: "noise"`，Node 会继续查 In-Reply-To，RN 会直接退到 providerId。

## 同账户跨设备

桌面和手机各有自己的数据库。服务器身份仍由 UIDVALIDITY、UID、文件夹路径决定，threadId 只控制本地归组，不改变服务器消息身份。上述消息可能在桌面归入引用链，在手机形成单封会话；移动后 providerId 改变，还可能改变手机的会话键。

[Store.upsertMessage](../../packages/core/src/store/store-messages.ts) 在缺少有效 References 且有 In-Reply-To 时，尝试继承本地父消息的 threadId；找不到父消息则沿用既有行的 threadId。父消息是否已缓存、两端同步窗口、历史读取顺序都会影响最终归组。相同账户可能显示不同会话数量与批量操作范围；按会话保存的提醒、稍后处理和派生摘要也不会跨设备自动对齐。消息文本及附件不会仅因 threadId 不同而丢失。

## 统一选项

- 统一到 Node：两端共用有效 ID 解析、字段回退和裸 ID 支持。还需统一 codec 输出的输入规范，避免 `noise` 等异常值因 codec 不同继续分歧。
- 统一到 RN：两端共用先选字段再匹配尖括号的算法。改动较小，但桌面会把已有裸引用链拆开，并保留异常字段阻断回退的问题。
- 定义新的共同算法：从缓存的原始邮件头生成规范 ID，逐字段回退，明确重复 References、空白、裸 ID 与异常值规则；两个 codec 只提供同一组输入。结果更稳定，但必须版本化并重算旧缓存。

## 迁移要求

统一算法后，不能只处理新拉取的邮件，否则一个数据库会同时保存两套会话键。

1. 在 `db/migrations.ts` 的 MIGRATIONS 末尾追加版本及重算进度，不能改已有迁移。逐账户、可续跑地重算；缺少邮件头的旧行先通过已有回填补齐。暂停相关归组改动与重算之间的竞态。
2. 使用 `UPDATE thread_id` 或现有 `upsertMessage` 的 `ON CONFLICT DO UPDATE`，保持 messages 的 rowid 和本地 ID。不得用 `INSERT OR REPLACE`；messages_fts 是外部内容表，必须继续与 rowid 对齐。验证迁移前后行数、rowid、FTS 搜索及完整性。
3. 记录旧会话与新会话的成员映射。会话可能合并或拆分，需明确 `thread_reminders`、`snoozed_messages` 的提醒日期与外键如何迁移；基于成员迁移撤销记录中的 threadId，并使旧 `derived` 会话摘要失效。`message_badges`、`message_search_meta` 的现有更新触发器会重投影，但仍需验证。
4. 保留 pending_ops 的 providerId、RFC Message-ID、复制进度、drafts 和 outbox；它们不应因会话重算而更换服务器身份或重新发送。
5. 对 Node 和 RN 数据库、合并／拆分、窗外父消息、缺头、重启续跑建立迁移回归。运行时和数据库迁移须使用同一算法版本。

建议采用新的共同算法，保留 Node 的逐字段回退和裸 ID 支持，输入统一为原始邮件头。先确定异常值与提醒合并／拆分规则，再实施追加迁移。本次仅固定差异测试，不重算缓存。
