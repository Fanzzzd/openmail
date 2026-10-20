# O30 server rule coverage

Checked against the official API docs on 2026-10-06. The status refers to the openmail editor: **Supported** means editable, **Read-only** keeps the server definition and points the user to the web to edit it, **Missing** means not wired up. There is no forwarding address verification flow, so no forward or redirect actions are added.

## Gmail

Sources: [Filter, Criteria, Action](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters), [filter actions guide](https://developers.google.com/workspace/gmail/api/guides/filter_settings), [writable range of system labels](https://developers.google.com/workspace/gmail/api/guides/labels).

| Criteria field   | Status    | Editing and preview                                              |
| ---------------- | --------- | ---------------------------------------------------------------- |
| `from`           | Supported | Sender name or address; server preview                           |
| `to`             | Supported | Recipient name or address, including To, CC, BCC; server preview |
| `subject`        | Supported | Subject contains; server preview                                 |
| `query`          | Supported | Search query, has the words; server preview                      |
| `negatedQuery`   | Supported | Excluded words/query; server preview                             |
| `hasAttachment`  | Supported | Has attachment; server preview                                   |
| `excludeChats`   | Supported | Exclude chats; the preview query uses `-is:chat`                 |
| `size`           | Supported | Full message size in bytes; server preview                       |
| `sizeComparison` | Supported | `larger`, `smaller`; an existing `unspecified` stays read-only   |

| Action field     | Status    | How to edit                                                                                                                                                                                                                                                                         |
| ---------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addLabelIds`    | Supported | Star, delete, label, importance, category and more label actions; the label set keeps multiple values. Native rules that add `INBOX`/`UNREAD`/`SPAM`/`SENT`/`DRAFT` are read-only. The filter guide does not list the first three as add actions, so the editor does not offer them |
| `removeLabelIds` | Supported | Archive, mark as read, mark not important, and remove user/system labels                                                                                                                                                                                                            |
| `forward`        | Read-only | Existing rules are kept; edit on the web                                                                                                                                                                                                                                            |

Unknown criteria/action fields stay read-only. Gmail has no update endpoint for filters, so a change still deletes and recreates the filter and uses the existing recovery mechanism. Restoring the original definition keeps unknown fields. The editor refuses to save when added and removed labels conflict.

## Outlook Graph v1.0

Sources: [messageRulePredicates](https://learn.microsoft.com/en-us/graph/api/resources/messagerulepredicates?view=graph-rest-1.0), [messageRuleActions](https://learn.microsoft.com/en-us/graph/api/resources/messageruleactions?view=graph-rest-1.0), [sizeRange](https://learn.microsoft.com/en-us/graph/api/resources/sizerange?view=graph-rest-1.0). Each predicate status below applies to both `conditions` and `exceptions`.

| Condition/exception field | Status    | Local preview                                                                                                                                                                                      |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bodyContains`            | Supported | Message text contains the whole string; undecidable when the message text is not cached                                                                                                            |
| `bodyOrSubjectContains`   | Supported | Message text or subject contains; undecidable when the subject does not match and the message text is not cached                                                                                   |
| `categories`              | Read-only | Edit on the web                                                                                                                                                                                    |
| `fromAddresses`           | Read-only | Keeps exact-address semantics; edit on the web                                                                                                                                                     |
| `hasAttachments`          | Supported | Cached Graph attachments already drop `isInline` at the provider boundary; undecidable when the attachment cache is empty and incomplete; native predicates with an explicit `false` are read-only |
| `headerContains`          | Supported | Undecidable, because cached headers may hold only some fields                                                                                                                                      |
| `importance`              | Supported | `low`, `normal`, `high`; the cache cannot tell all levels apart, so the preview is undecidable                                                                                                     |
| `isApprovalRequest`       | Read-only | Edit on the web                                                                                                                                                                                    |
| `isAutomaticForward`      | Read-only | Edit on the web                                                                                                                                                                                    |
| `isAutomaticReply`        | Supported | Message type metadata is missing, so the preview is undecidable                                                                                                                                    |
| `isEncrypted`             | Read-only | Edit on the web                                                                                                                                                                                    |
| `isMeetingRequest`        | Read-only | Edit on the web                                                                                                                                                                                    |
| `isMeetingResponse`       | Read-only | Edit on the web                                                                                                                                                                                    |
| `isNonDeliveryReport`     | Read-only | Edit on the web                                                                                                                                                                                    |
| `isPermissionControlled`  | Read-only | Edit on the web                                                                                                                                                                                    |
| `isReadReceipt`           | Read-only | Edit on the web                                                                                                                                                                                    |
| `isSigned`                | Read-only | Edit on the web                                                                                                                                                                                    |
| `isVoicemail`             | Read-only | Edit on the web                                                                                                                                                                                    |
| `messageActionFlag`       | Supported | All 11 values; the native action flag is missing, so the preview is undecidable                                                                                                                    |
| `notSentToMe`             | Supported | BCC is incomplete, so the preview is undecidable                                                                                                                                                   |
| `recipientContains`       | Supported | Name/address in To or CC contains; BCC is not counted                                                                                                                                              |
| `senderContains`          | Supported | From name/address contains                                                                                                                                                                         |
| `sensitivity`             | Supported | `normal`, `personal`, `private`, `confidential`; metadata is missing, so the preview is undecidable                                                                                                |
| `sentCcMe`                | Supported | The account identity or a cached send-as alias is in CC; undecidable when the identity set is unknown                                                                                              |
| `sentOnlyToMe`            | Supported | BCC is incomplete, so the preview is undecidable                                                                                                                                                   |
| `sentToAddresses`         | Read-only | Keeps exact-address semantics; edit on the web                                                                                                                                                     |
| `sentToMe`                | Supported | The account identity or a cached send-as alias is in To; undecidable when the identity set is unknown                                                                                              |
| `sentToOrCcMe`            | Supported | The account identity or a cached send-as alias is in To or CC; undecidable when the identity set is unknown                                                                                        |
| `subjectContains`         | Supported | Subject contains the whole string                                                                                                                                                                  |
| `withinSizeRange`         | Supported | Minimum and maximum are both editable, in KiB; bounds are inclusive; undecidable when the message size is missing                                                                                  |

Editable `messageActionFlag` values: `any`, `call`, `doNotForward`, `followUp`, `fyi`, `forward`, `noResponseNecessary`, `read`, `reply`, `replyToAll`, `review`. Here `forward` is an action flag that matches incoming messages. It does not forward anything.

| Action field            | Status    | Editing and scope                                                                                      |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `assignCategories`      | Supported | One category per line; multiple categories allowed; applies only to new mail on the server             |
| `copyToFolder`          | Supported | Pick from the account's folder list; applies only to new mail on the server                            |
| `delete`                | Supported | Move to Deleted Items; can apply to existing mail in the preview                                       |
| `forwardAsAttachmentTo` | Read-only | Kept; edit on the web                                                                                  |
| `forwardTo`             | Read-only | Kept; edit on the web                                                                                  |
| `markAsRead`            | Supported | Mark as read; can apply to existing mail in the preview                                                |
| `markImportance`        | Supported | Low/normal/high; applies only to new mail on the server                                                |
| `moveToFolder`          | Supported | Archive or pick a folder                                                                               |
| `permanentDelete`       | Read-only | Kept; the editor does not offer permanent-delete rules                                                 |
| `redirectTo`            | Read-only | Kept; edit on the web                                                                                  |
| `stopProcessingRules`   | Supported | Stops later server rules; an explicit `false` is kept; when on, applies only to new mail on the server |

## Preservation and preview rules

- Outlook string collections are edited only as a single value. Rules with multiple values, unknown fields, unknown enum values, unknown size range members, or Graph's `isReadOnly` mark stay read-only. Neither reading nor an attempted change overwrites the server definition. Exceptions get the same protection.
- Local preview and confirmation share one matcher. Text matches as a case-insensitive whole string, and search operators are not interpreted. Condition fields combine with AND, exception fields with OR. Recipient matching uses only the address range each native predicate names.
- Recipient relationship checks use only the current account identity and the send-as addresses cached for that account. They never borrow another account's identity. Without an identity cache for the account, these conditions and exceptions are undecidable.
- Every rule that deletes or moves to trash shows a deletion warning and requires confirmation, including Outlook rules and rules without a search query.
- When metadata is insufficient, the editor shows "Preview unavailable". The confirmation result carries the missing fields and shows no guessed hit count. Such a rule can be saved for the server to apply to new mail, but cannot be applied to existing mail.
- Outlook local preview scans at most 10,001 cached candidates. Confirmation uses at most 201 candidates returned by the server and filters them with the same matcher. The result shows/applies at most 200 messages and notes the limit when truncated. It is not a full mailbox count. `hasWords`/`notWords` are still checked on the candidate set. When the message text is not cached they are undecidable, and the editor does not fake a hit count even when online.
- Outlook categories, copy, the three importance levels and stop processing rules have no matching operation on existing mail, so "Apply to existing mail" refuses them instead of silently ignoring them.

There is no lossless translation yet from Outlook's whole-string contains into a provider search. [Graph message search](https://learn.microsoft.com/en-us/graph/search-query-parameter#use-search-on-message-collections) uses KQL, and [KQL free-text queries](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/keyword-query-language-kql-syntax-reference#using-words-in-the-free-text-keyql-query) match by term and prefix, which cannot directly replace arbitrary substring matching. This is why candidate search stays and O30 is partial.

The Graph provider's native attachment list drops inline attachments. Extra attachments parsed from MIME or UU message text do not carry native `isInline` metadata, so the attachment preview for such cached mail can still differ from Graph.

Implementation: `organization.ts`, `outlook-rules.ts`, the two provider settings modules, `mailbox-organization.ts` and `ServerSettings.tsx`. `server-rules.test.ts` uses fake HTTP to check new request bodies, saving again and clearing, read-only preservation, and agreement between cached preview and confirmation. The tests do not use real provider APIs.
