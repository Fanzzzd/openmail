# Mail corpus check

`corpus-check` runs the mail processing code over each message in a local cache copy and prints summary diagnostics or per-message structure diagnostics. It needs no Electron, sign-in, network, keychain or model.

```sh
pnpm build
pnpm cli corpus-check --db /path/to/mailbox-copy.db
pnpm cli corpus-check --db /path/to/mailbox-copy.db --limit 1000 --json > /tmp/corpus-report.json
```

`--db` is required. Only mail with `body_cached=1` is processed, in descending date order, with ties sorted by ID. `--limit` defaults to all, and 0 only checks that the database is readable. The output contains no database path, subject, name, address, message text, URL, file name or raw header.

## Per-message structure diagnostics and run keys

When you will need to locate single messages later, scan with `--explain-ready`. The key is saved to a 0600 file outside the report, and the file path goes only to stderr. Neither the JSON nor the text report contains the key or the path:

```sh
pnpm cli corpus-check --db /path/to/mailbox-copy.db --explain-ready --json > /tmp/corpus-report.json
# HASH comes from the report's samples; RUN_KEY is the Run key file path from stderr.
HASH='put the sample hash here'
RUN_KEY='/path/from/stderr/run.key'
pnpm cli corpus-check --db /path/to/mailbox-copy.db --explain "$HASH" --run-key "$RUN_KEY" --json
# Rerun the summary with the same cache copy and key to compare the same messages:
pnpm cli corpus-check --db /path/to/mailbox-copy.db --run-key "$RUN_KEY" --json
```

`--explain` takes a 64-character hex hash and requires `--run-key`. It cannot be combined with `--limit` or `--explain-ready`. When the hash is not found, it returns a fixed error and does not fall back to another message. `--run-key` can reuse an existing 0600 regular file. Summary mode can also name a file path that does not exist yet, and the key is created there. Symlinks, permissions other than 0600, and wrong length or content are rejected. When an ordinary scan specifies neither option, the random key stays only in memory, and the report cannot be used to locate a single message after the run.

Sample `hash = HMAC-SHA256(key=32-byte random key, data=UTF-8 decimal messages.rowid)`. The hash is no longer based on the message ID. The report version is 2, and old reports made with `--salt` cannot be reused directly. Locating a message requires keeping the same cache copy, because rebuilding the database can change rowids. The key file is not deleted when the scan ends. Delete it yourself after the diagnosis, and share only the report if you need to share anything. The report is still sensitive diagnostic material and is not guaranteed to be anonymous.

Single-message mode parses only the selected cache row and reuses the same read-only copy, MIME decoding, sanitizing, visible text path and worker limits. The output is JSON, also when `--json` is omitted. It contains no message text, class/ID names, attribute values, CSS declaration values, URLs, file names or raw stacks.

- `mode=explain`. `sample` carries the hash, provider, size bucket and MIME structure.
- `status` is `complete`, `failed`, `timeout`, `aborted` or `size-limit`. A failure carries only the fixed exception class, stage and code entry point. When diagnostics did not finish, `diagnostics=null`.
- `textPlainNonEmpty` means the cached `body_text` is non-empty after trimming whitespace. `decodedTextPlainNonEmpty` is the same check after re-decoding. The cache does not keep the source of the original MIME part, so these two fields cannot prove that an original text/plain part exists.
- `cachedHtml` is the structure of the originally cached HTML. `original` starts from the re-decoded HTML, and `sanitized` starts from the reader-sanitize stage output. The visible text of both finally goes through reader sanitizing, the reference shell and HTML5 parsing. The difference between the two checks that repeated sanitizing is stable. It is not a comparison of unsanitized text with reader text.
- `structure` holds the total element count, counts for a fixed set of HTML tags, text node count and character count, comment and MSO conditional comment counts, maximum depth, the number of texts inside head, whether body sits inside head, and the number of style blocks and inline style attributes. Custom tags all count as `other`.
- `stylesheetSelectorShapes` counts only selector types and allowlisted syntax, such as `class-selector`, `id-selector`, `attribute-selector`, `:not`, `:has`, combinators and `@media`. Unknown pseudo-classes count only as `pseudo-class`, unknown at-rules as `@other`. Parse failures are only counted.
- `removedByRule` is the number of text nodes and characters dropped by the filter branch that actually fired. It covers hidden/aria-hidden, display:none, visibility, opacity, zero/tiny font, near-identical color, negative offset, scale, zoom, content-visibility, undetermined CSS, clipping, filter opacity, uncertain painting, positioned occlusion and OMIT tags. `removedBySource` totals the same removals by HTML attribute, inline style, stylesheet rule, inherited value, OMIT and comment. The two groups are different dimensions and cannot be added together.
- Each pruned DOM subtree counts once and is attributed to the first rule that fired. Once an ancestor is pruned, descendant rules are not counted. font-size/visibility are counted on text leaves by effective inherited value, so a descendant can override them. The rules are in [mail content protection](security.md#mail-content-protection). MSO and ordinary comments produce no DOM text nodes. Their inert content is parsed separately, and the potential text nodes and characters count under the matching comment category. This part cannot be compared directly with the actual DOM node total.
- Character counts use UTF-16 code units and include whitespace and the style/script text inside OMIT tags. `retainedTextNodes` and `retainedCharacters` are raw counts of kept nodes. `visibleCharacters` is the text length after whitespace normalization. Whitespace consumed by normalization is not attributed to hiding rules.
- `budgetExceeded`, `cssRuleBudgetHits` and `nestingDepthLimitHits` come from the actual visibility check. Structure and selector statistics do no browser layout and read no external CSS.

## Input and read-only boundary

A scan always first copies the DB and any existing WAL into a temporary directory with mode 0700, with files at 0600. It does not copy config, keychain or attachment files, does not open a SQLite connection to the source database, and does not create the source's SHM or lock files. Before and after the copy it compares file identity, size, modification time and status change time. If the source file changed, it retries up to three times, and refuses to scan if it still changes. For a database under continuous writes, the user must first take a stable copy. The copy opens with `DatabaseSync({ readOnly: true, allowExtension: false })` and is checked for `query_only=ON`. No migrations, backfills or cache maintenance run. The temporary directory is deleted at the end, on an exception or on cancel.

An ordinary OpenMail cache keeps only decoded message text, with no raw MIME or full MIME tree. `mimeSource=reconstructed-cached-utf8` means the cached text is rebuilt as UTF-8 MIME, passed through `normalizeMimeCharsets`, Node MailCodec and `compatibleMime`, and then turned into text with `withDecodedBody`. This can find compatibility parsing problems that the cached content triggers. It cannot reproduce the original transfer encoding, lost characters or problems unpacking signed attachments. The charset replacement diagnostic counts the U+FFFD present in the cache and the re-decoded output. It does not prove which decoding introduced the error.

## Report fields

- `version`: report format version, currently 2. The key and its file path are not report fields.
- `processed`: cache rows read, including rows that failed, timed out or were skipped by the size limit.
- `source`: always `temporary-read-only-snapshot`.
- `limits`: message processing deadline 2000 ms by default, worker startup deadline 15000 ms, 16 MiB cap on the total bytes of a message's cached fields, 96 MiB worker old-generation heap cap, and at most 5 samples kept per anomaly and per stage failure class.
- `stages`: each stage's `count` is the number of starts, `completed` the number of returns, and `failures` totals by fixed exception class and code entry point. The code entry point is the call site, not a raw stack or the line number of the root cause. A timeout is assigned to the last stage that started but did not finish. Stages after a failed cache parse do not run. Rows skipped by the size limit have no stage timings.
- `timeMs`: p50 and p95 are upper bounds estimated from a fixed log histogram, with error of at most 5% of the true value plus 0.00005 ms. max is the actual maximum. The times include failures and timeouts, and exclude copying, row reads, worker startup and message passing. The total processing deadline covers all stages, and a separate main-thread timer can stop a synchronous parse.
- `anomalies`: the top level totals counts and samples per anomaly. Within stages there are only counts. The same mail triggering the same anomaly in different stages counts once per stage. Link and event counts are by number found, and the rest by stage observations. Samples are the first five distinct messages in scan order.

Each sample has only `hash`, a fixed-enum `provider`, `sizeBucket` and `contentTypeStructure`. Size prefers the message size the provider cached, and falls back to the byte count of the cached fields. The structure allows only a fixed set of MIME types. Unknown types are written as `other`, all parameters are dropped, and at most 16 attachment types are listed. This structure is derived from the top-level Content-Type, the cached text and the attachment metadata. It is not the full raw MIME tree. When the cache parse did not finish, the structure is `other[]`. Oversized rows can also keep samples through the rowid hash without reading the full message ID.

## Stages and anomalies

| Stage              | Code path                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| cache-decode       | Schema validation of the SQLite cache row; parse error details are not output                                       |
| mime-decode        | Rebuilt MIME, mime-compat, Node MailCodec, withDecodedBody                                                          |
| reader-sanitize    | sanitizeReaderHtml after prepareMessageHtml, with remote resources off                                              |
| visible-text       | visibleHtmlText on the original HTML and on the reader-sanitized HTML                                               |
| model-text         | modelContext, including hidden text filtering, quote trimming and the context byte budget                           |
| link-security      | Collects sanitized link labels in the same visible text walk; linkDisplayMismatch                                   |
| message-security   | messageSecurity on cached Authentication-Results and the account's explicit authserv-id; checks Date and Message-ID |
| structured-events  | structuredMailEvents on the original HTML, keeping the JSON-LD detection path                                       |
| snippet-plain-text | Plain text and snippet generation from htmlToText and withDecodedBody                                               |
| fts-tokenize       | SQLite trigram and unicode61; subject/body use the same tokenizers as the production index                          |

The FTS stage uses a temporary index in a separate `:memory:` database and clears it after each message. Only this volatile in-memory index sees inserts and deletes. The mailbox database and its copy receive no writes.

| Anomaly                 | Meaning                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sanitizer-text-loss     | After the reader pipeline is applied again to the stage's sanitized result, the visible character count is below 10% of the first result                                                                                                                                                                                                                      |
| empty-visible-text      | The HTML is non-empty but the visible text after sanitizing is empty                                                                                                                                                                                                                                                                                          |
| budget-exceeded         | The visibility check ran out of budget, model text rejected a complex message, or structured events exceeded their 1 million character input cap                                                                                                                                                                                                              |
| charset-replacements    | U+FFFD makes up more than 1% of the Unicode characters in the decoded message text and HTML                                                                                                                                                                                                                                                                   |
| css-rule-budget         | visibleHtmlText actually ran out of its CSS rule budget, reported by the parser diagnostic hook                                                                                                                                                                                                                                                               |
| oversized-html          | The HTML is larger than 1 MiB in UTF-8 bytes                                                                                                                                                                                                                                                                                                                  |
| nesting-depth-limit     | Visible text extraction actually hit the 512-level flattening limit                                                                                                                                                                                                                                                                                           |
| link-display-mismatch   | The whole visible label is itself a URL/domain and its registrable domain differs from the target. Ordinary words, sentences with an embedded URL and hidden links do not count. When the CSS budget runs out, links that cannot be confirmed visible do not count. The reader still checks domains embedded in sentences. Redirect targets are never visited |
| failed-date-parse       | The cached timestamp cannot be converted to a date, or an existing Date header fails to parse. A missing Date header does not count as a failure                                                                                                                                                                                                              |
| missing-message-id      | Both the cached RFC Message-ID and any existing Message-ID header are empty or missing                                                                                                                                                                                                                                                                        |
| structured-events-found | Number of structured events recognized                                                                                                                                                                                                                                                                                                                        |
| timeout                 | The per-message total processing deadline ran out and the worker was terminated; a cancel from the core caller also interrupts the current message                                                                                                                                                                                                            |
| message-size-limit      | The cached fields exceed 16 MiB; the SQL projection skips the large fields and never reads their full content                                                                                                                                                                                                                                                 |

For responsive mail, the cascade is computed at reference reading widths of 720px and 1080px, and only text nodes visible in every environment scenario and at both widths are kept. Unhiding must also cover integer CSS px from 0 to 8000. Media environments such as light/dark get separate cascades, and dynamic pseudo-classes cannot establish trust that content is shown. The specific media conditions and the handling of uncertain environments are in [mail content protection](security.md#mail-content-protection). A desktop version hidden only below 600px can be kept. A mobile version hidden by default and shown only on narrow screens is excluded. Diagnostic counts count each DOM node once and do not add the results of the two widths.

Reading uses a SQLite iterator that sends one row at a time and waits for processing to finish before continuing. Statistics use fixed histograms, and the number of report samples and failure classes is capped. The check does not accumulate mail, links, tokens or per-message timings. After a timeout or a worker failure, it terminates and recreates the worker and continues with the next message. The parser has its own V8 heap cap, which is not a cap on the RSS of the whole process.

Verification uses synthetic caches, malicious HTML, bad JSON and a temporary database with WAL on, and checks every stage, the read-only source file, timeouts, sample caps and content leaks. For the CLI fixture's summary and explain JSON, the tests assert one by one that every subject, address, message text word and private selector/tag name is absent. Regressions check locating a single message with a private key file, and that ordinary-word labels on tracking links do not count as domain mismatches. A real cache copy gets a read-only summary check only with the user's explicit permission, and no mail content is output.

API and tokenizer behavior follow [Node SQLite](https://nodejs.org/api/sqlite.html), [Node Worker](https://nodejs.org/api/worker_threads.html), [SQLite FTS5](https://sqlite.org/fts5.html) and [htmlparser2](https://github.com/fb55/htmlparser2).
