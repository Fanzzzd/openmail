import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { type Fragment } from "effect/sql/Statement";
import { type AttachmentType, type SearchCondition, type ThreadQuery } from "./domain.js";
import {
  ATTACHMENT_TYPES,
  expressionHasSize,
  ftsSearchTerm,
  hasSearchExpression,
  parseSearchExpression,
  parseSearchQuery,
  quoteSearchValue,
  type SearchExpression,
  searchIncludesSpecialFolders,
  searchWords,
  typedDrivePath,
  unquoteSearchValue,
  usesSubstringSearch,
  wordTokens,
} from "./search.js";
import { all } from "./sql-rows.js";
import { MAILBOX_LABEL } from "./mailbox-labels.js";

export type LocalQuery = ThreadQuery & {
  wordIndexReady?: boolean;
  derivedWordIndexReady?: boolean;
  rowBoundText?: boolean;
  textPage?: { index: "messages_words" | "messages_fts"; match: string };
};

export const expressionMedia = (text: string) =>
  hasSearchExpression(text) || searchWords(text).some((term) => term.startsWith("-"));

export const EFFECTIVE_DATE = "m.list_date";

export const SUMMARY_COLUMNS = `m.id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr,
  ${EFFECTIVE_DATE} AS date,
  m.snippet, m.labels_json, m.attachments_json, m.is_unread, m.is_starred`;

const literalLike = (value: string) =>
  `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
const phrase = (words: readonly string[]) => quoteSearchValue(words.join(" "));

export const makeQueryStore = ({ sql }: { sql: SqlClient.SqlClient }) => {
  const hasLabel = (label: string) => labelIn(sql, label);

  // An empty profile matches nothing rather than everything.
  const inAccounts = (ids: readonly string[]) => accountScope(sql, ids);

  // Messages

  const imapFolder = (
    folder: import("./services.js").ImapFolderIdentity,
    column = sql.literal("m.provider_id"),
  ) =>
    sql`${column}>=${`${folder.uidValidity}:`} AND ${column}<${`${folder.uidValidity};`} AND substr(${column}, instr(${column}, ':') + instr(substr(${column}, instr(${column}, ':') + 1), ':') + 1)=${folder.path}`;

  const outsideKeep = (keep?: readonly string[]) =>
    keep?.length
      ? sql`m.provider_id NOT IN (SELECT value FROM json_each(${JSON.stringify(keep)}))`
      : sql.literal("1");

  const textFilter = (
    value: string,
    derived: boolean,
    ready: boolean,
    subjectOnly = false,
    rowBound = false,
  ): Fragment => {
    const match = ftsSearchTerm(value);
    if (!match) return sql.literal("1");
    const text = unquoteSearchValue(value.endsWith("*") ? value.slice(0, -1) : value);
    if (ready && !usesSubstringSearch(text)) {
      if (rowBound)
        return derived
          ? sql`EXISTS (SELECT 1 FROM derived_words WHERE rowid=d.id AND derived_words MATCH ${match})`
          : sql`EXISTS (SELECT 1 FROM messages_words WHERE rowid=m.rowid AND messages_words MATCH ${subjectOnly ? `subject : ${match}` : match})`;
      return derived
        ? sql`d.id IN (SELECT rowid FROM derived_words WHERE derived_words MATCH ${match})`
        : sql`m.rowid IN (SELECT rowid FROM messages_words WHERE messages_words MATCH ${subjectOnly ? `subject : ${match}` : match})`;
    }
    if (Array.from(text).length >= 3) {
      const literal = ftsSearchTerm(quoteSearchValue(text));
      if (rowBound)
        return derived
          ? sql`EXISTS (SELECT 1 FROM derived_fts WHERE rowid=d.id AND derived_fts MATCH ${literal})`
          : sql`EXISTS (SELECT 1 FROM messages_fts WHERE rowid=m.rowid AND messages_fts MATCH ${subjectOnly ? `subject : ${literal}` : literal})`;
      return derived
        ? sql`d.id IN (SELECT rowid FROM derived_fts WHERE derived_fts MATCH ${literal})`
        : sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${subjectOnly ? `subject : ${literal}` : literal})`;
    }
    const like = literalLike(text);
    return derived
      ? sql`d.text LIKE ${like} ESCAPE '\\'`
      : subjectOnly
        ? sql`m.subject LIKE ${like} ESCAPE '\\'`
        : sql`(m.subject LIKE ${like} ESCAPE '\\' OR m.from_name LIKE ${like} ESCAPE '\\' OR m.from_addr LIKE ${like} ESCAPE '\\' OR m.body_text LIKE ${like} ESCAPE '\\')`;
  };

  const attachmentTypeFilter = (type: AttachmentType): Fragment => {
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

  const proximityFilter = (
    p: NonNullable<SearchCondition["proximity"]>,
    derived = false,
    ready = true,
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
        WITH candidates AS MATERIALIZED (SELECT rowid FROM ${index} WHERE ${index} MATCH ${near}),
        positions AS MATERIALIZED (SELECT term,doc,col,offset FROM ${table} WHERE term IN (SELECT value FROM json_each(${JSON.stringify([...new Set([...left, ...right])])})) AND doc IN (SELECT rowid FROM candidates))
        SELECT DISTINCT a.doc FROM positions a JOIN positions b ON b.doc=a.doc AND b.col=a.col
        WHERE a.term=${left[0]} AND b.term=${right[0]} AND (${p.ordered ? forward : sql`(${forward}) OR (${reverse})`}) AND ${sql.and([...samePhrase(left, "a"), ...samePhrase(right, "b")])}
      )`;
  };

  const searchConditionFilter = (c: SearchCondition, ready = false, rowBound = false): Fragment => {
    const where: Fragment[] = [];
    if (c.unread !== undefined) where.push(sql`m.is_unread=${c.unread ? 1 : 0}`);
    if (c.starred !== undefined) where.push(sql`m.is_starred=${c.starred ? 1 : 0}`);
    if (c.bcc)
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.bcc_json) WHERE json_extract(value,'$.address') LIKE ${literalLike(c.bcc)} ESCAPE '\\' OR json_extract(value,'$.name') LIKE ${literalLike(c.bcc)} ESCAPE '\\')`,
      );
    if (c.proximity) where.push(proximityFilter(c.proximity, false, ready));
    if (c.subjectContains)
      where.push(sql`m.subject LIKE ${literalLike(c.subjectContains)} ESCAPE '\\'`);
    if (c.mailingList)
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.headers_json) h WHERE lower(json_extract(h.value,'$.name')) IN ('list-id','list-post') AND (json_extract(h.value,'$.value') LIKE ${literalLike(c.mailingList)} ESCAPE '\\' OR (lower(json_extract(h.value,'$.name'))='list-id' AND json_extract(h.value,'$.value') LIKE ${literalLike(c.mailingList.replace("@", "."))} ESCAPE '\\'))) `,
      );
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
        sql`(m.body_text LIKE '%https://drive.google.com/%' OR m.body_html LIKE '%https://drive.google.com/%' OR m.body_text LIKE '%https://docs.google.com/%' OR m.body_html LIKE '%https://docs.google.com/%')`,
      );
    if (c.cc)
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.cc_json) WHERE json_extract(value,'$.address') LIKE ${literalLike(c.cc)} ESCAPE '\\' OR json_extract(value,'$.name') LIKE ${literalLike(c.cc)} ESCAPE '\\')`,
      );
    for (const type of c.attachmentTypes ?? []) where.push(attachmentTypeFilter(type));
    if (c.from)
      where.push(
        sql`(m.from_addr LIKE ${literalLike(c.from)} ESCAPE '\\' OR m.from_name LIKE ${literalLike(c.from)} ESCAPE '\\')`,
      );
    if (c.to)
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.to_json) WHERE json_extract(value, '$.address') LIKE ${literalLike(c.to)} ESCAPE '\\' OR json_extract(value, '$.name') LIKE ${literalLike(c.to)} ESCAPE '\\')`,
      );
    if (c.subject) where.push(textFilter(c.subject, false, ready, true, rowBound));
    if (c.important) where.push(hasLabel("IMPORTANT"));
    if (c.attachmentText)
      where.push(sql`EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id)`);
    if (c.image) where.push(sql`(${attachmentTypeFilter("image")} OR m.body_html LIKE '%cid:%')`);
    if (c.attachment !== undefined)
      where.push(
        c.attachment
          ? sql`json_array_length(m.attachments_json)>0`
          : sql`json_array_length(m.attachments_json)=0`,
      );
    if (c.filename)
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.attachments_json) WHERE json_extract(value, '$.filename') LIKE ${literalLike(c.filename)} ESCAPE '\\')`,
      );
    if (c.dateBefore !== undefined) where.push(sql`m.date < ${c.dateBefore}`);
    if (c.dateAfter !== undefined) where.push(sql`m.date >= ${c.dateAfter}`);
    for (const label of c.labels ?? [])
      where.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) j WHERE j.value=${label} OR j.value IN (SELECT id FROM labels WHERE account_id=m.account_id AND name=${label}))`,
      );
    return sql.and(where);
  };

  type ExpressionContext = {
    messagesReady: boolean;
    derivedReady: boolean;
    media: boolean;
    attachmentOnly: boolean;
    rowBound: boolean;
  };

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
        return expressionHasSize(node.child)
          ? sql`(m.message_size IS NULL OR NOT (${expressionFilter(node.child, context)}))`
          : sql`NOT (${expressionFilter(node.child, context)})`;
      case "term": {
        const q = parseSearchQuery({ search: node.value });
        const conditions = [
          searchConditionFilter(q.criteria ?? {}, context.messagesReady, context.rowBound),
        ];
        if (q.criteria?.proximity) {
          const body = conditions.pop() ?? sql.literal("1");
          const derived = sql`EXISTS (SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND ${proximityFilter(q.criteria.proximity, true, context.derivedReady)})`;
          conditions.push(
            context.attachmentOnly ? derived : context.media ? sql`(${body} OR ${derived})` : body,
          );
        }
        if (q.unreadOnly) conditions.push(sql`m.is_unread=1`);
        if (q.starredOnly) conditions.push(sql`m.is_starred=1`);
        if (q.search) {
          const body = textFilter(q.search, false, context.messagesReady, false, context.rowBound);
          const derived = sql`EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND ${textFilter(q.search, true, context.derivedReady, false, context.rowBound)})`;
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

  /** WHERE clauses of a thread list. Paging (`before`) is applied after collapsing threads. */
  const listFilter = (q: LocalQuery) => {
    const where: Fragment[] = [sql`m.account_id IN (SELECT id FROM accounts WHERE enabled=1)`];
    const mailbox =
      q.search !== undefined && q.searchScope !== "folder" ? "all" : (q.mailbox ?? "inbox");
    if (mailbox === "all") {
      if (q.messageIds === undefined && !searchIncludesSpecialFolders(q))
        where.push(sql`NOT ${hasLabel("SPAM")}`, sql`NOT ${hasLabel("TRASH")}`);
    } else where.push(hasLabel(MAILBOX_LABEL[mailbox]));
    if (mailbox === "inbox")
      where.push(
        sql`NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL)`,
      );
    if (q.label !== undefined && (q.search === undefined || q.searchScope === "folder"))
      where.push(hasLabel(q.label));
    if (q.accountIds) where.push(inAccounts(q.accountIds));
    if (q.messageIds)
      where.push(sql`m.id IN (SELECT value FROM json_each(${JSON.stringify(q.messageIds)}))`);
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
    where.push(searchConditionFilter(q.criteria ?? {}, q.wordIndexReady ?? false, q.rowBoundText));
    for (const condition of q.criteria?.excluded ?? [])
      where.push(
        condition.sizeLarger !== undefined || condition.sizeSmaller !== undefined
          ? sql`(m.message_size IS NULL OR NOT (${searchConditionFilter(condition, q.wordIndexReady ?? false, q.rowBoundText)}))`
          : sql`NOT (${searchConditionFilter(condition, q.wordIndexReady ?? false, q.rowBoundText)})`,
      );
    where.push(
      expressionFilter(parseSearchExpression(q.search ?? ""), {
        messagesReady: q.wordIndexReady ?? false,
        derivedReady: q.derivedWordIndexReady ?? false,
        media: expressionMedia(q.search ?? ""),
        attachmentOnly: q.criteria?.attachmentText ?? false,
        rowBound: q.rowBoundText ?? false,
      }),
    );
    return sql.and(where);
  };

  // Stream the date/id index and resolve only selected conversations. The
  // CTE is inlined, so a 100k-thread inbox does not rank 100k rows per page.
  const listSource = (q: LocalQuery) =>
    // Across accounts SQLite otherwise sorts the entire inbox using the
    // account/date index. Walk the global date index and stop at the limit.
    // Search keeps the planner free to start from its selective FTS rowids.
    q.textPage && q.messageIds === undefined && q.accountIds?.length === 1
      ? sql.literal("messages m INDEXED BY messages_account_list_date_id")
      : (q.textPage || q.search === undefined) &&
          q.messageIds === undefined &&
          q.accountIds?.length !== 1
        ? sql.literal("messages m INDEXED BY messages_list_date_id")
        : sql.literal("messages m");

  const planTextPage = Effect.fnUntraced(function* (q: LocalQuery) {
    const words = searchWords(q.search ?? "");
    if (
      words.length !== 1 ||
      expressionMedia(q.search ?? "") ||
      hasSearchExpression(q.search ?? "") ||
      Object.keys(q.criteria ?? {}).length ||
      q.messageIds ||
      (q.label && q.searchScope === "folder")
    )
      return q;
    const word = words[0];
    if (!word || word.startsWith("-")) return q;
    const text = unquoteSearchValue(word.endsWith("*") ? word.slice(0, -1) : word);
    const ready = q.wordIndexReady && !usesSubstringSearch(text);
    if (!ready && Array.from(text).length < 3) return q;
    const match = ftsSearchTerm(ready ? word : quoteSearchValue(text));
    if (!match) return q;
    const table = sql.literal(ready ? "messages_words" : "messages_fts");
    const rows = yield* all(Schema.Struct({ n: Schema.Number }))(sql`SELECT COUNT(*) AS n FROM (
        SELECT rowid FROM ${table} WHERE ${table} MATCH ${match} LIMIT 2049)`);
    // A bounded probe distinguishes rare terms from common ones. Common
    // terms walk the date index, probing FTS by rowid only for recent rows.
    return (rows[0]?.n ?? 0) > 2048
      ? ({
          ...q,
          textPage: { index: ready ? "messages_words" : "messages_fts", match },
          rowBoundText: true,
        } satisfies LocalQuery)
      : q;
  });
  return {
    hasLabel,
    inAccounts,
    imapFolder,
    outsideKeep,
    textFilter,
    listFilter,
    listSource,
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
  sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = ${label})`;
