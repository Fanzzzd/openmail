import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { type Fragment } from "effect/sql/Statement";
import type { AttachmentType, SearchCondition, ThreadQuery } from "../domain/message.js";
import {
  expressionHasSize,
  hasSearchExpression,
  parseSearchExpression,
  parseSearchQuery,
  type SearchExpression,
  searchIncludesSpecialFolders,
} from "../search/search.js";
import { ATTACHMENT_TYPES } from "../search/attachment-types.js";
import { ftsSearchTerm, usesSubstringSearch, wordTokens } from "../search/fts.js";
import { quoteSearchValue, searchTermText, searchWords } from "../search/search-tokens.js";
import { typedDrivePath } from "../search/search-match.js";
import { SEARCH_FLAG_BITS } from "../db/search-flags.js";
import { OPERATOR_TEXT_SEPARATORS } from "../db/operator-text.js";
import { bigramMatch } from "../search/search-bigrams.js";
import { all } from "./sql-rows.js";
import { MAILBOX_LABEL } from "../domain/mailbox-labels.js";

export type LocalQuery = ThreadQuery & {
  wordIndexReady?: boolean;
  derivedWordIndexReady?: boolean;
  rowBoundText?: boolean;
  proximityPage?: { kind: "prefilter" } | { kind: "exact"; messageIds?: readonly string[] };
  textPage?: { index: "messages_words" | "messages_fts" | "messages_bigrams"; match: string };
  /** message_operator_text has a row for every message (migration 57's backfill is done). */
  operatorTextReady?: boolean;
  /**
   * Read Spam/Trash eligibility from message_search_meta, as text pages do. A count sets it:
   * labels_json sits after the body columns, so `NOT label SPAM` read each counted row's
   * overflow pages (cold `weekly OR alpha` count 3.4 s, 1.6 GB read).
   */
  metaEligible?: boolean;
};

export const expressionMedia = (text: string) =>
  hasSearchExpression(text) || searchWords(text).some((term) => term.startsWith("-"));

export const EFFECTIVE_DATE = "m.list_date";

/** A search term in more messages than this walks the date index (planTextPage). */
export const COMMON_TERM_ROWS = 2048;

const ROW_WALK_KEYS: ReadonlySet<string> = new Set([
  "from",
  "unread",
  "starred",
  "important",
  "attachment",
]);
const OPERATOR_TEXT_KEYS: ReadonlySet<string> = new Set(["to", "cc", "filename", "mailingList"]);

/**
 * Operators a date walk tests on the walked row, so a common word with them walks the date
 * index instead of starting from the word's rowids. `-to:nobody weekly` started from the 100k
 * rowids of `weekly` and took 0.8 s for a page. labels_json, is_unread and is_starred are in
 * messages_list_date_id; from: reads the row's from columns, before the body; has:attachment
 * reads attachments_json once per walked row until the page fills. subject: probes the word
 * index by rowid like a plain word. to:, cc:, filename: and list: read message_operator_text
 * once per statement, so they walk only once its backfill is done. An excluded subject: or
 * label: keeps the rowid start.
 */
const walkableCriteria = (q: LocalQuery) => {
  const sideTable = q.operatorTextReady === true;
  const walkable = (key: string) =>
    ROW_WALK_KEYS.has(key) || (sideTable && OPERATOR_TEXT_KEYS.has(key));
  const { excluded = [], ...criteria } = q.criteria ?? {};
  return (
    Object.keys(criteria).every((key) => walkable(key) || key === "subject" || key === "labels") &&
    excluded.every((condition) => Object.keys(condition).every(walkable))
  );
};

export const SUMMARY_COLUMNS = `m.id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr,
  ${EFFECTIVE_DATE} AS date,
  m.snippet, m.labels_json, m.attachments_json, m.is_unread, m.is_starred`;

/** The word index MATCH term of a word, or null for text the word index does not split. */
const wordIndexTerm = (word: string) =>
  usesSubstringSearch(searchTermText(word)) ? null : ftsSearchTerm(word);

const literalLike = (value: string) =>
  `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
const phrase = (words: readonly string[]) => quoteSearchValue(words.join(" "));

const containsProximity = (node: SearchExpression): boolean => {
  switch (node.kind) {
    case "term":
      return !!parseSearchQuery({ search: node.value }).criteria?.proximity;
    case "not":
      return containsProximity(node.child);
    case "and":
    case "or":
      return node.children.some(containsProximity);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

export const listIndex = (q: LocalQuery) => {
  const boundedPage = !!q.textPage || q.proximityPage?.kind === "prefilter";
  // A label list or a mailbox view other than Inbox tests labels_json on each walked row, also
  // in one account. The global date index covers labels_json and the account index does not:
  // walking the account index read each of its rows from the table until the page filled
  // (600 ms for a folder on 1 in 67 of 100k messages, 30 ms on the global index).
  const labelView =
    q.search === undefined &&
    (q.label !== undefined ||
      (q.mailbox !== undefined && q.mailbox !== "inbox" && q.mailbox !== "all"));
  // Across accounts SQLite otherwise sorts the entire inbox using the
  // account/date index. Walk the global date index and stop at the limit.
  // Search keeps the planner free to start from its selective FTS rowids.
  return boundedPage && q.messageIds === undefined && q.accountIds?.length === 1
    ? "messages_account_list_date_id"
    : (boundedPage || q.search === undefined) &&
        q.messageIds === undefined &&
        (q.accountIds?.length !== 1 || labelView)
      ? "messages_list_date_id"
      : undefined;
};

/**
 * A search page on the plain table starts from the text index's rowids. Its account filter
 * reads `+m.account_id`: without statistics SQLite preferred walking every message of the
 * selected accounts through messages_account_date.
 */
export const searchDrivenList = (q: LocalQuery) =>
  listIndex(q) === undefined && q.search !== undefined && q.search.trim() !== "";

export const makeQueryStore = ({ sql }: { sql: SqlClient.SqlClient }) => {
  const hasLabel = (label: string) => labelIn(sql, label);
  const idsIn = (ids: readonly string[]) =>
    sql`SELECT value FROM json_each(${JSON.stringify(ids)})`;

  // An empty profile matches nothing rather than everything.
  const inAccounts = (ids: readonly string[]) => accountScope(sql, ids);

  // Messages

  const imapFolder = (
    folder: import("../providers/adapter.js").ImapFolderIdentity,
    column = sql.literal("m.provider_id"),
  ) =>
    sql`${column}>=${`${folder.uidValidity}:`} AND ${column}<${`${folder.uidValidity};`} AND substr(${column}, instr(${column}, ':') + instr(substr(${column}, instr(${column}, ':') + 1), ':') + 1)=${folder.path}`;

  const outsideKeep = (keep?: readonly string[]) =>
    keep?.length
      ? sql`m.provider_id NOT IN (SELECT value FROM json_each(${JSON.stringify(keep)}))`
      : sql.literal("1");

  const messageLike = (like: string, subjectOnly: boolean): Fragment =>
    subjectOnly
      ? sql`m.subject LIKE ${like} ESCAPE '\\'`
      : sql`(m.subject LIKE ${like} ESCAPE '\\' OR m.from_name LIKE ${like} ESCAPE '\\' OR m.from_addr LIKE ${like} ESCAPE '\\' OR m.body_text LIKE ${like} ESCAPE '\\')`;

  /** Rows the bigram index has not reached yet, matched with LIKE. */
  const queuedBigramRows = (like: string, derived: boolean, subjectOnly: boolean): Fragment =>
    derived
      ? sql`(d.id IN (SELECT row_id FROM search_bigram_pending WHERE kind='derived') AND d.text LIKE ${like} ESCAPE '\\')`
      : sql`(m.rowid IN (SELECT row_id FROM search_bigram_pending WHERE kind='messages') AND ${messageLike(like, subjectOnly)})`;

  const textFilter = (
    value: string,
    derived: boolean,
    ready: boolean,
    subjectOnly = false,
  ): Fragment => {
    const match = ftsSearchTerm(value);
    if (!match) return sql.literal("1");
    const text = searchTermText(value);
    if (ready && !usesSubstringSearch(text))
      return derived
        ? sql`d.id IN (SELECT rowid FROM derived_words WHERE derived_words MATCH ${match})`
        : sql`m.rowid IN (SELECT rowid FROM messages_words WHERE messages_words MATCH ${subjectOnly ? `subject : ${match}` : match})`;
    if (Array.from(text).length >= 3) {
      const literal = ftsSearchTerm(quoteSearchValue(text));
      return derived
        ? sql`d.id IN (SELECT rowid FROM derived_fts WHERE derived_fts MATCH ${literal})`
        : sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${subjectOnly ? `subject : ${literal}` : literal})`;
    }
    const like = literalLike(text);
    const bigram = bigramMatch(text);
    if (bigram) {
      // Indexed rows answer from the bigram index; rows still queued use LIKE.
      const query = subjectOnly ? `subject : ${bigram}` : bigram;
      const indexed = derived
        ? sql`d.id IN (SELECT rowid FROM derived_bigrams WHERE derived_bigrams MATCH ${query})`
        : sql`m.rowid IN (SELECT rowid FROM messages_bigrams WHERE messages_bigrams MATCH ${query})`;
      return sql`(${indexed} OR ${queuedBigramRows(like, derived, subjectOnly)})`;
    }
    return derived ? sql`d.text LIKE ${like} ESCAPE '\\'` : messageLike(like, subjectOnly);
  };

  /**
   * Messages with an attachment or other derived chunk that matches a word. An index answers
   * with one set of message ids for the statement. A correlated `d.id IN (MATCH)` probed
   * derived_chunks_message once per matching chunk for every message tested: `invoice OR
   * weekly`, where invoice is in 10k OCR chunks, took 19.6 s. `+m.id` keeps the set from
   * driving the row walk. Queued bigram rows and LIKE keep the per-message test.
   */
  const derivedTextFilter = (value: string, ready: boolean): Fragment => {
    const text = searchTermText(value);
    const match = ftsSearchTerm(value);
    const index =
      match === null
        ? undefined
        : ready && !usesSubstringSearch(text)
          ? sql`SELECT rowid FROM derived_words WHERE derived_words MATCH ${match}`
          : Array.from(text).length >= 3
            ? sql`SELECT rowid FROM derived_fts WHERE derived_fts MATCH ${ftsSearchTerm(quoteSearchValue(text))}`
            : undefined;
    return index
      ? sql`+m.id IN (SELECT d.message_id FROM derived_chunks d WHERE d.id IN (${index}))`
      : sql`EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND ${textFilter(value, true, ready)})`;
  };

  /**
   * textFilter over a message's own text for a page that walks the date index (rowBoundText).
   * Each row looks its rowid up in the text index, so the index's rowid set does not drive the
   * walk. planTextPage sets rowBoundText only for plain words and subject:, so there is no
   * attachment text variant.
   */
  const rowBoundTextFilter = (value: string, ready: boolean, subjectOnly = false): Fragment => {
    const match = ftsSearchTerm(value);
    if (!match) return sql.literal("1");
    const text = searchTermText(value);
    if (ready && !usesSubstringSearch(text)) {
      const query = subjectOnly ? `subject : ${match}` : match;
      // The word index has no prefix index, so a probe for `pe*` expands the prefix over the
      // whole term list for every row (5.9 s for 200 threads of 100k messages). A prefix reads
      // its rowids once instead. `+0` keeps the set from driving the row walk.
      return match.endsWith("*")
        ? sql`(m.rowid+0) IN (SELECT rowid FROM messages_words WHERE messages_words MATCH ${query})`
        : sql`EXISTS (SELECT 1 FROM messages_words WHERE rowid=m.rowid AND messages_words MATCH ${query})`;
    }
    // planTextPage walks the date index for subject: only on the word index.
    if (subjectOnly) return textFilter(value, false, ready, true);
    if (Array.from(text).length >= 3)
      return sql`EXISTS (SELECT 1 FROM messages_fts WHERE rowid=m.rowid AND messages_fts MATCH ${ftsSearchTerm(quoteSearchValue(text))})`;
    const like = literalLike(text);
    const bigram = bigramMatch(text);
    if (bigram)
      return sql`(EXISTS (SELECT 1 FROM messages_bigrams WHERE rowid=m.rowid AND messages_bigrams MATCH ${bigram}) OR ${queuedBigramRows(like, false, false)})`;
    return messageLike(like, false);
  };

  /** Rows written or backfilled since migration 45 read their flags; older rows run `scan`. */
  const flagFilter = (bits: number, scan: Fragment): Fragment =>
    sql`(m.rowid IN (SELECT row_id FROM message_search_meta WHERE search_flags>0 AND (search_flags & ${bits})!=0) OR (m.rowid IN (SELECT row_id FROM message_search_meta WHERE search_flags IS NULL) AND (${scan})))`;

  const attachmentTypeScan = (type: AttachmentType): Fragment => {
    const spec = ATTACHMENT_TYPES[type];
    const mime = sql`lower(trim(substr(json_extract(a.value,'$.mimeType'), 1, instr(json_extract(a.value,'$.mimeType') || ';', ';') - 1)))`;
    const drivePath = typedDrivePath(type);
    const attachment = sql`EXISTS (SELECT 1 FROM json_each(m.attachments_json) a WHERE ${sql.or([
      ...(type === "image" ? [sql`${mime} LIKE 'image/%'`] : []),
      sql`${mime} IN (SELECT value FROM json_each(${JSON.stringify(spec.mimeTypes)}))`,
      ...spec.extensions.map(
        (ext) => sql`lower(json_extract(a.value,'$.filename')) LIKE ${`%.${ext}`}`,
      ),
    ])})`;
    return drivePath
      ? sql`(${attachment} OR m.body_text LIKE ${`%https://docs.google.com/${drivePath}/%`} OR m.body_html LIKE ${`%https://docs.google.com/${drivePath}/%`})`
      : attachment;
  };
  const DRIVE_PATH_BITS = {
    document: SEARCH_FLAG_BITS.driveDocument,
    spreadsheets: SEARCH_FLAG_BITS.driveSpreadsheet,
    presentation: SEARCH_FLAG_BITS.drivePresentation,
  } as const;
  const attachmentTypeFilter = (type: AttachmentType): Fragment => {
    const drivePath = typedDrivePath(type);
    return flagFilter(
      SEARCH_FLAG_BITS[type] | (drivePath ? DRIVE_PATH_BITS[drivePath] : 0),
      attachmentTypeScan(type),
    );
  };

  const proximityFilter = (
    p: NonNullable<SearchCondition["proximity"]>,
    derived = false,
    ready = true,
    context: Pick<LocalQuery, "proximityPage"> = {},
  ): Fragment => {
    const left = wordTokens(p.left),
      right = wordTokens(p.right);
    if (!left.length || !right.length) return sql.literal("0");
    if (!ready)
      return sql.and([
        textFilter(quoteSearchValue(p.left), derived, false),
        textFilter(quoteSearchValue(p.right), derived, false),
      ]);
    const index = sql.literal(derived ? "derived_words" : "messages_words");
    const id = sql.literal(derived ? "d.id" : "m.rowid");
    if (p.distance === 0) {
      // Adjacent non-overlapping phrases are one FTS phrase. Let the index
      // verify positions instead of materializing and joining the instance stream.
      const forward = phrase([...left, ...right]);
      const match = p.ordered ? forward : `${forward} OR ${phrase([...right, ...left])}`;
      return sql`${id} IN (SELECT rowid FROM ${index} WHERE ${index} MATCH ${match})`;
    }
    const table = sql.literal(derived ? "derived_word_positions" : "messages_word_positions");
    const near = `NEAR(${phrase(left)} ${phrase(right)}, ${p.distance})`;
    if (context.proximityPage?.kind === "prefilter")
      return sql`${id} IN (SELECT rowid FROM ${index} WHERE ${index} MATCH ${near})`;
    const messageIds =
      context.proximityPage?.kind === "exact" ? context.proximityPage.messageIds : undefined;
    const scope = messageIds
      ? sql`AND (rowid+0) IN (${derived ? sql`SELECT id FROM derived_chunks WHERE message_id IN (${idsIn(messageIds)})` : sql`SELECT rowid FROM messages WHERE id IN (${idsIn(messageIds)})`})`
      : sql.literal("");
    const samePhrase = (words: string[], alias: "a" | "b") =>
      words.slice(1).map((word, i) => {
        const ref = sql.literal(alias);
        return sql`EXISTS (SELECT 1 FROM positions w WHERE w.doc=${ref}.doc AND w.col=${ref}.col AND w.offset=${ref}.offset+${i + 1} AND w.term=${word})`;
      });
    const forward = sql`b.offset>=a.offset+${left.length} AND b.offset-a.offset-${left.length}<=${p.distance}`;
    const reverse = sql`a.offset>=b.offset+${right.length} AND a.offset-b.offset-${right.length}<=${p.distance}`;
    // These materialized sets have no outer-row references: FTS and each term's
    // instance stream are read once, not once per candidate message/chunk.
    return sql`${id} IN (
        WITH candidates AS MATERIALIZED (SELECT rowid FROM ${index} WHERE ${index} MATCH ${near} ${scope}),
        positions AS MATERIALIZED (SELECT term,doc,col,offset FROM ${table} WHERE term IN (SELECT value FROM json_each(${JSON.stringify([...new Set([...left, ...right])])})) AND doc IN (SELECT rowid FROM candidates))
        SELECT DISTINCT a.doc FROM positions a JOIN positions b ON b.doc=a.doc AND b.col=a.col
        WHERE a.term=${left[0]} AND b.term=${right[0]} AND (${p.ordered ? forward : sql`(${forward}) OR (${reverse})`}) AND ${sql.and([...samePhrase(left, "a"), ...samePhrase(right, "b")])}
      )`;
  };

  /**
   * to:, cc:, filename: and list: read message_operator_text once per statement instead of
   * json_each over each message row. `+0` keeps the set from driving the row walk. Before the
   * backfill is done, and for a value that contains the column's separators, the per-row test
   * stays.
   */
  const operatorText = (
    context: Pick<LocalQuery, "operatorTextReady">,
    values: readonly string[],
    indexed: () => Fragment,
    scan: () => Fragment,
  ): Fragment =>
    context.operatorTextReady &&
    values.every(
      (value) =>
        value !== "" && !OPERATOR_TEXT_SEPARATORS.some((separator) => value.includes(separator)),
    )
      ? sql`(m.rowid+0) IN (SELECT row_id FROM message_operator_text WHERE ${indexed()})`
      : scan();

  const searchConditionFilter = (
    c: SearchCondition,
    ready = false,
    context: Pick<LocalQuery, "proximityPage" | "rowBoundText" | "operatorTextReady"> = {},
  ): Fragment => {
    const where: Fragment[] = [];
    if (c.unread !== undefined) where.push(sql`m.is_unread=${c.unread ? 1 : 0}`);
    if (c.starred !== undefined) where.push(sql`m.is_starred=${c.starred ? 1 : 0}`);
    if (c.bcc)
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.bcc_json) WHERE json_extract(value,'$.address') LIKE ${literalLike(c.bcc)} ESCAPE '\\' OR json_extract(value,'$.name') LIKE ${literalLike(c.bcc)} ESCAPE '\\')`,
      );
    if (c.proximity) where.push(proximityFilter(c.proximity, false, ready, context));
    if (c.subjectContains)
      where.push(sql`m.subject LIKE ${literalLike(c.subjectContains)} ESCAPE '\\'`);
    const list = c.mailingList;
    if (list) {
      const dotted = list.replace("@", ".");
      where.push(
        operatorText(
          context,
          [list, dotted],
          () =>
            sql`list_id_text LIKE ${literalLike(list)} ESCAPE '\\' OR list_post_text LIKE ${literalLike(list)} ESCAPE '\\' OR list_id_text LIKE ${literalLike(dotted)} ESCAPE '\\'`,
          () =>
            sql`EXISTS (SELECT 1 FROM json_each(m.headers_json) h WHERE lower(json_extract(h.value,'$.name')) IN ('list-id','list-post') AND (json_extract(h.value,'$.value') LIKE ${literalLike(list)} ESCAPE '\\' OR (lower(json_extract(h.value,'$.name'))='list-id' AND json_extract(h.value,'$.value') LIKE ${literalLike(dotted)} ESCAPE '\\'))) `,
        ),
      );
    }
    if (c.header)
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.headers_json) h WHERE lower(json_extract(h.value,'$.name'))=${c.header.name.toLowerCase()} AND json_extract(h.value,'$.value') LIKE ${literalLike(c.header.value)} ESCAPE '\\')`,
      );
    if (c.userLabels !== undefined) {
      const labeled = sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) j JOIN labels l ON l.account_id=m.account_id AND l.id=j.value WHERE j.value NOT LIKE 'CATEGORY_%' AND j.value NOT LIKE 'category:%')`;
      where.push(c.userLabels ? labeled : sql`NOT (${labeled})`);
    }
    if (c.rfcMessageId)
      where.push(sql`trim(m.rfc_message_id, '<>')=${c.rfcMessageId.replace(/^<|>$/g, "")}`);
    if (c.sizeLarger !== undefined)
      where.push(sql`(m.message_size IS NULL OR m.message_size > ${c.sizeLarger})`);
    if (c.sizeSmaller !== undefined)
      where.push(sql`(m.message_size IS NULL OR m.message_size < ${c.sizeSmaller})`);
    if (c.drive)
      where.push(
        flagFilter(
          SEARCH_FLAG_BITS.drive,
          sql`m.body_text LIKE '%https://drive.google.com/%' OR m.body_html LIKE '%https://drive.google.com/%' OR m.body_text LIKE '%https://docs.google.com/%' OR m.body_html LIKE '%https://docs.google.com/%'`,
        ),
      );
    const cc = c.cc;
    if (cc)
      where.push(
        operatorText(
          context,
          [cc],
          () => sql`cc_text LIKE ${literalLike(cc)} ESCAPE '\\'`,
          () =>
            sql`EXISTS (SELECT 1 FROM json_each(m.cc_json) WHERE json_extract(value,'$.address') LIKE ${literalLike(cc)} ESCAPE '\\' OR json_extract(value,'$.name') LIKE ${literalLike(cc)} ESCAPE '\\')`,
        ),
      );
    for (const type of c.attachmentTypes ?? []) where.push(attachmentTypeFilter(type));
    if (c.from)
      where.push(
        sql`(m.from_addr LIKE ${literalLike(c.from)} ESCAPE '\\' OR m.from_name LIKE ${literalLike(c.from)} ESCAPE '\\')`,
      );
    const to = c.to;
    if (to)
      where.push(
        operatorText(
          context,
          [to],
          () => sql`to_text LIKE ${literalLike(to)} ESCAPE '\\'`,
          () =>
            sql`EXISTS (SELECT 1 FROM json_each(m.to_json) WHERE json_extract(value, '$.address') LIKE ${literalLike(to)} ESCAPE '\\' OR json_extract(value, '$.name') LIKE ${literalLike(to)} ESCAPE '\\')`,
        ),
      );
    if (c.subject)
      where.push(
        context.rowBoundText
          ? rowBoundTextFilter(c.subject, ready, true)
          : textFilter(c.subject, false, ready, true),
      );
    if (c.important) where.push(hasLabel("IMPORTANT"));
    if (c.attachmentText)
      where.push(sql`EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id)`);
    if (c.image)
      where.push(
        flagFilter(
          SEARCH_FLAG_BITS.image | SEARCH_FLAG_BITS.inlineImage,
          sql`(${attachmentTypeScan("image")} OR m.body_html LIKE '%cid:%')`,
        ),
      );
    if (c.attachment !== undefined)
      where.push(
        c.attachment
          ? sql`json_array_length(m.attachments_json)>0`
          : sql`json_array_length(m.attachments_json)=0`,
      );
    const filename = c.filename;
    if (filename)
      where.push(
        operatorText(
          context,
          [filename],
          () => sql`file_text LIKE ${literalLike(filename)} ESCAPE '\\'`,
          () =>
            sql`EXISTS (SELECT 1 FROM json_each(m.attachments_json) WHERE json_extract(value, '$.filename') LIKE ${literalLike(filename)} ESCAPE '\\')`,
        ),
      );
    // Unary plus keeps SQLite off messages_account_date. Without ANALYZE the
    // planner prefers its date range over the thread index inside threadPage's
    // correlated subqueries, which turns every page into an O(n^2) scan.
    if (c.dateBefore !== undefined) where.push(sql`+m.date < ${c.dateBefore}`);
    if (c.dateAfter !== undefined) where.push(sql`+m.date >= ${c.dateAfter}`);
    // Names match without regard to case, like Gmail's label:. NOCASE folds ASCII only.
    // The name lookup does not refer to m, so SQLite builds its (account, id) list once per
    // statement. `account_id=m.account_id` inside it rebuilt the list for every message.
    for (const label of c.labels ?? [])
      where.push(
        sql`(${hasLabel(label)} OR EXISTS (SELECT 1 FROM json_each(m.labels_json) j WHERE (m.account_id,j.value) IN (SELECT account_id,id FROM labels WHERE name=${label} COLLATE NOCASE)))`,
      );
    return sql.and(where);
  };

  type ExpressionContext = {
    messagesReady: boolean;
    derivedReady: boolean;
    media: boolean;
    attachmentOnly: boolean;
    rowBound: boolean;
  } & Pick<LocalQuery, "proximityPage" | "operatorTextReady">;

  const expressionFilter = (node: SearchExpression, context: ExpressionContext): Fragment => {
    switch (node.kind) {
      case "and": {
        const scoped =
          context.attachmentOnly ||
          node.children.some(
            (child) =>
              child.kind === "term" &&
              parseSearchQuery({ search: child.value }).criteria?.attachmentText === true,
          );
        return sql`(${sql.and(node.children.map((child) => expressionFilter(child, { ...context, attachmentOnly: scoped })))})`;
      }
      case "or":
        return sql`(${sql.or(node.children.map((child) => expressionFilter(child, context)))})`;
      case "not":
        // NEAR is a superset of exact AROUND. Negating that superset would
        // lose valid rows, so leave these branches to the exact candidate pass.
        if (context.proximityPage?.kind === "prefilter" && containsProximity(node.child))
          return sql.literal("1");
        return expressionHasSize(node.child)
          ? sql`(m.message_size IS NULL OR NOT (${expressionFilter(node.child, context)}))`
          : sql`NOT (${expressionFilter(node.child, context)})`;
      case "term": {
        const q = parseSearchQuery({ search: node.value });
        const conditions = [
          searchConditionFilter(q.criteria ?? {}, context.messagesReady, context),
        ];
        if (q.criteria?.proximity) {
          const body = conditions.pop() ?? sql.literal("1");
          const derived = sql`EXISTS (SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND ${proximityFilter(q.criteria.proximity, true, context.derivedReady, context)})`;
          conditions.push(
            context.attachmentOnly ? derived : context.media ? sql`(${body} OR ${derived})` : body,
          );
        }
        if (q.unreadOnly) conditions.push(sql`m.is_unread=1`);
        if (q.starredOnly) conditions.push(sql`m.is_starred=1`);
        if (q.search) {
          const body = context.rowBound
            ? rowBoundTextFilter(q.search, context.messagesReady)
            : textFilter(q.search, false, context.messagesReady);
          const derived = derivedTextFilter(q.search, context.derivedReady);
          conditions.push(
            context.attachmentOnly ? derived : context.media ? sql`(${body} OR ${derived})` : body,
          );
        }
        return sql`(${sql.and(conditions)})`;
      }
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  };

  /**
   * WHERE clauses of a thread list. Paging (`before`) is applied after collapsing threads.
   * `keyed`: the caller already pins rows by id or rowid. The account filter then reads
   * `+m.account_id` so SQLite without statistics does not walk an account's whole date index
   * instead of looking the rows up.
   */
  const listFilter = (
    q: LocalQuery,
    keyed = q.messageIds !== undefined ||
      (q.proximityPage?.kind === "exact" && q.proximityPage.messageIds !== undefined),
  ) => {
    const where: Fragment[] = [sql`+m.account_id IN (SELECT id FROM accounts WHERE enabled=1)`];
    const mailbox =
      q.search !== undefined && q.searchScope !== "folder" ? "all" : (q.mailbox ?? "inbox");
    if (mailbox === "all") {
      if (q.messageIds === undefined && !searchIncludesSpecialFolders(q))
        where.push(
          q.textPage || q.proximityPage || q.search === "" || q.metaEligible
            ? sql`EXISTS (SELECT 1 FROM message_search_meta s WHERE s.row_id=m.rowid AND s.eligible=1)`
            : sql`NOT ${hasLabel("SPAM")} AND NOT ${hasLabel("TRASH")}`,
        );
    } else where.push(hasLabel(MAILBOX_LABEL[mailbox]));
    if (mailbox === "inbox")
      where.push(
        sql`NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL)`,
      );
    if (q.label !== undefined && (q.search === undefined || q.searchScope === "folder"))
      where.push(hasLabel(q.label));
    if (q.accountIds)
      where.push(
        keyed ? accountScope(sql, q.accountIds, "+m.account_id") : inAccounts(q.accountIds),
      );
    if (q.messageIds) where.push(sql`m.id IN (${idsIn(q.messageIds)})`);
    if (q.proximityPage?.kind === "exact" && q.proximityPage.messageIds)
      where.push(sql`m.id IN (${idsIn(q.proximityPage.messageIds)})`);
    if (q.unreadOnly) where.push(sql`m.is_unread = 1`);
    if (q.starredOnly) where.push(sql`m.is_starred = 1`);
    const filters = q.listFilters;
    if (filters?.enabled) {
      const flags: Fragment[] = [];
      if (filters.unread) flags.push(sql`m.is_unread = 1`);
      if (filters.starred) flags.push(sql`m.is_starred = 1`);
      if (filters.important) flags.push(hasLabel("IMPORTANT"));
      if (flags.length) where.push(sql`(${sql.or(flags)})`);
      if (filters.inInbox) where.push(hasLabel("INBOX"));
    }
    where.push(searchConditionFilter(q.criteria ?? {}, q.wordIndexReady ?? false, q));
    for (const condition of q.criteria?.excluded ?? []) {
      if (q.proximityPage?.kind === "prefilter" && condition.proximity) continue;
      const filter = searchConditionFilter(condition, q.wordIndexReady ?? false, q);
      where.push(
        condition.sizeLarger !== undefined || condition.sizeSmaller !== undefined
          ? sql`(m.message_size IS NULL OR NOT (${filter}))`
          : sql`NOT (${filter})`,
      );
    }
    where.push(
      expressionFilter(parseSearchExpression(q.search ?? ""), {
        messagesReady: q.wordIndexReady ?? false,
        derivedReady: q.derivedWordIndexReady ?? false,
        media: expressionMedia(q.search ?? ""),
        attachmentOnly: q.criteria?.attachmentText ?? false,
        rowBound: q.rowBoundText ?? false,
        proximityPage: q.proximityPage,
        operatorTextReady: q.operatorTextReady,
      }),
    );
    return sql.and(where);
  };

  // Stream the date/id index and resolve only selected conversations. The
  // CTE is inlined, so a 100k-thread inbox does not rank 100k rows per page.
  const listSource = (q: LocalQuery) => {
    const index = listIndex(q);
    return sql.literal(index ? `messages m INDEXED BY ${index}` : "messages m");
  };

  /**
   * Marks a plain search for the date index walk when its text index entry matches more than
   * COMMON_TERM_ROWS messages. A bounded probe tells rare terms from common ones: a rare term
   * starts from its rowids, a common one walks the date index and probes the text index by
   * rowid only for recent rows.
   */
  const commonTerm = Effect.fnUntraced(function* (
    q: LocalQuery,
    index: NonNullable<LocalQuery["textPage"]>["index"],
    match: string,
  ) {
    const table = sql.literal(index);
    const rows = yield* all(Schema.Struct({ n: Schema.Number }))(sql`SELECT COUNT(*) AS n FROM (
        SELECT rowid FROM ${table} WHERE ${table} MATCH ${match} LIMIT ${sql.literal(String(COMMON_TERM_ROWS + 1))})`);
    return (rows[0]?.n ?? 0) > COMMON_TERM_ROWS
      ? ({ ...q, textPage: { index, match }, rowBoundText: true } satisfies LocalQuery)
      : q;
  });

  const planTextPage = Effect.fnUntraced(function* (q: LocalQuery) {
    const words = searchWords(q.search ?? "");
    const subject = q.criteria?.subject;
    if (
      (words.length === 0 && subject === undefined) ||
      expressionMedia(q.search ?? "") ||
      hasSearchExpression(q.search ?? "") ||
      !walkableCriteria(q) ||
      q.messageIds ||
      (q.label && q.searchScope === "folder")
    )
      return q;
    if (subject !== undefined || words.length > 1) {
      // Plain words AND together. Common words found together in most mail walk the date
      // index like one common word; the rowid sets of `weekly` and `de*` are each about every
      // message, and starting from one of them read 100k rows for a page (8 s for 200 threads).
      // A common subject: word walks it too: starting from the rowids of `subject:report` read
      // every matching message for a page.
      const subjectTerm = subject === undefined ? undefined : wordIndexTerm(subject);
      const terms = words.map(wordIndexTerm);
      if (!q.wordIndexReady || subjectTerm === null || terms.some((t) => t === null)) return q;
      return yield* commonTerm(
        q,
        "messages_words",
        [...(subjectTerm === undefined ? [] : [`(subject : ${subjectTerm})`]), ...terms].join(
          " AND ",
        ),
      );
    }
    const word = words[0];
    if (!word || word.startsWith("-")) return q;
    const text = searchTermText(word);
    const ready = q.wordIndexReady && !usesSubstringSearch(text);
    const bigram = ready ? undefined : bigramMatch(text);
    // Common short terms walk the date index too; queued rows still use LIKE per row.
    if (bigram) return yield* commonTerm(q, "messages_bigrams", bigram);
    if (!ready && Array.from(text).length < 3) return q;
    const match = ftsSearchTerm(ready ? word : quoteSearchValue(text));
    if (!match) return q;
    return yield* commonTerm(q, ready ? "messages_words" : "messages_fts", match);
  });
  return {
    hasLabel,
    inAccounts,
    imapFolder,
    outsideKeep,
    textFilter,
    listFilter,
    listSource,
    searchDrivenList,
    planTextPage,
  };
};

/** Undefined means all accounts; an empty selection matches none. */
export const accountScope = (
  sql: SqlClient.SqlClient,
  ids?: readonly string[],
  column = "m.account_id",
): Fragment =>
  ids === undefined
    ? sql.literal("1")
    : ids.length === 0
      ? sql.literal("0")
      : sql`${sql.literal(column)} IN ${sql.in(ids)}`;
const labelIn = (sql: SqlClient.SqlClient, label: string): Fragment =>
  label === "CATEGORY_PERSONAL"
    ? sql`CASE WHEN m.account_id IN (SELECT id FROM accounts WHERE provider='outlook')
        THEN NOT EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value='CATEGORY_OTHER')
        ELSE EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value=${label}) END`
    : sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = ${label})`;
