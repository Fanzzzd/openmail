# Verify sync reset delete candidates

Status: accepted.

## Context

The coordinator ran sync-health on a read-only copy of real data and got these results:

| Outlook folder |         Messages on the server |                                      Local messages |
| -------------- | -----------------------------: | --------------------------------------------------: |
| Inbox          | 28,666, of which 26,042 unread | 1,199 before the restart, about 91 after re-listing |
| Sent           |                             98 |                                                  65 |
| Archive        |                            103 |                                                  52 |

The loss after the 410 restart cannot be explained by the server's Inbox shrinking. The confirmed client bug: a delta listing that was never shown to be complete served as the keep set for the whole folder, and about 1,100 local messages were deleted. The source also allowed the listing to end with neither a nextLink nor a deltaLink, and dropped a listed ID when the single-item GET for a message without a conversationId returned 404. The old Outlook loop had no 90-day or 2,000-message cutoff and no date filter. The current code limits the date range explicitly, adds every listed ID to the keep set at once, fetches failed full reads later, and verifies missing items inside the window.

The coordinator then checked `532b888` on a read-only copy of real data. Outlook kept 1,479 messages and made no mass deletion. New diagnostics showed that after the 410 restart, the Inbox listing stage reported `listed:50, kept:50`, the reset stage had a global keep set of 53, and the folder held 512 local messages in scope. The 50 matched the `$top=50` in the old initial delta URL. In this observation Graph treated `$top` as the limit for the whole round. It returned a deltaLink with no nextLink after 50 messages, so the adapter stopped listing.

The root-cause fix moves the page size into the `Prefer: odata.maxpagesize` request header and removes `$top` from delta request URLs, including explicit parameters in old cursors. A fake Graph in the regression test reproduces "stop after 50" when `$top` is present. With the header it pages 50, 50 and 23 and delivers all 123 messages. Initial sync, the 410 restart, continuation pages and the next incremental round all check the header and the ImmutableId setting. The window range, the guard on the 5,000-message filter limit, per-item verification and persistent re-verification stay in force. The existing regression with 28,666 server messages, 1,199 cached in the window and 91 listed still checks local retention through `syncHealth`, and covers mail outside the window, UID reuse, moves and failures.

Retry and send confirmation live in [provider-retry.ts](../../packages/core/src/providers/provider-retry.ts), [Gmail](../../packages/core/src/providers/gmail/gmail.ts), [Outlook](../../packages/core/src/providers/outlook/outlook.ts) and [mailbox-live.ts](../../packages/core/src/mailbox/mailbox-live.ts). UID reset and send regressions are in [uid-remap.test.ts](../../packages/core/src/mailbox/uid-remap.test.ts) and [store.test.ts](../../packages/core/src/store/store.test.ts).

## Decision and impact

A server listing that has not been shown to be complete is never grounds for deletion. Delete candidates go into a persistent verification queue and are deleted only after the server confirms they are gone. The Graph page size is set through a request header. Failed and unverified items stay in the cache. The current sync rules are in the [sync notes](../sync-correctness.md#重置删除保护).
