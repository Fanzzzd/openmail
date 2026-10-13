/** Bits for has: search operators, and the SQL that computes them. Migrations 45 and later embed this SQL. */

/**
 * Bits in `message_search_meta.search_flags` for has: operators that would otherwise
 * scan every body or attachment list. NULL means not computed yet.
 */
export const SEARCH_FLAG_BITS = {
  /** Any https://drive.google.com/ or https://docs.google.com/ link. */
  drive: 1,
  /** https://docs.google.com/{document,spreadsheets,presentation}/ links. */
  driveDocument: 2,
  driveSpreadsheet: 4,
  drivePresentation: 8,
  pdf: 16,
  image: 32,
  document: 64,
  spreadsheet: 128,
  presentation: 256,
  /** An inline cid: image reference in body_html. */
  inlineImage: 512,
} as const;
/**
 * The attachment rules of search.ts ATTACHMENT_TYPES when migration 45 was written.
 * The migration's triggers embed them, so they never change here; a test keeps
 * ATTACHMENT_TYPES equal to this copy, and a new rule needs a new migration.
 */
export const SEARCH_FLAG_ATTACHMENT_TYPES_45 = {
  pdf: { mimeTypes: ["application/pdf"], extensions: ["pdf"] },
  image: {
    mimeTypes: [],
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "heic",
      "heif",
      "tif",
      "tiff",
      "bmp",
      "svg",
      "avif",
    ],
  },
  document: {
    mimeTypes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.oasis.opendocument.text",
      "application/rtf",
      "text/rtf",
      "text/plain",
    ],
    extensions: ["doc", "docx", "odt", "rtf", "txt"],
  },
  spreadsheet: {
    mimeTypes: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.spreadsheet",
      "text/csv",
    ],
    extensions: ["xls", "xlsx", "ods", "csv", "tsv"],
  },
  presentation: {
    mimeTypes: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.presentation",
    ],
    extensions: ["ppt", "pptx", "odp", "key"],
  },
} as const;
const flagBit = (condition: string, value: number) =>
  `(CASE WHEN ${condition} THEN ${value} ELSE 0 END)`;
/** LIKE is ASCII case-insensitive, matching the lowercase checks on fetched mail. */
export const searchFlags = (row: string) => {
  const body = (url: string) =>
    `${row}.body_text LIKE '%${url}%' OR ${row}.body_html LIKE '%${url}%'`;
  const mime = `lower(trim(substr(json_extract(a.value,'$.mimeType'), 1, instr(json_extract(a.value,'$.mimeType') || ';', ';') - 1)))`;
  const attachment = (type: keyof typeof SEARCH_FLAG_ATTACHMENT_TYPES_45) => {
    const spec = SEARCH_FLAG_ATTACHMENT_TYPES_45[type];
    const tests = [
      ...(type === "image" ? [`${mime} LIKE 'image/%'`] : []),
      ...(spec.mimeTypes.length
        ? [`${mime} IN (${spec.mimeTypes.map((value) => `'${value}'`).join(",")})`]
        : []),
      ...spec.extensions.map((ext) => `lower(json_extract(a.value,'$.filename')) LIKE '%.${ext}'`),
    ];
    return `EXISTS (SELECT 1 FROM json_each(${row}.attachments_json) a WHERE ${tests.join(" OR ")})`;
  };
  const b = SEARCH_FLAG_BITS;
  return `(${[
    flagBit(`${body("https://drive.google.com/")} OR ${body("https://docs.google.com/")}`, b.drive),
    flagBit(body("https://docs.google.com/document/"), b.driveDocument),
    flagBit(body("https://docs.google.com/spreadsheets/"), b.driveSpreadsheet),
    flagBit(body("https://docs.google.com/presentation/"), b.drivePresentation),
    flagBit(attachment("pdf"), b.pdf),
    flagBit(attachment("image"), b.image),
    flagBit(attachment("document"), b.document),
    flagBit(attachment("spreadsheet"), b.spreadsheet),
    flagBit(attachment("presentation"), b.presentation),
    flagBit(`${row}.body_html LIKE '%cid:%'`, b.inlineImage),
  ].join(" | ")})`;
};
/** Fills `search_flags` for rows written before migration 45. */
export const BACKFILL_SEARCH_FLAGS = `UPDATE message_search_meta SET search_flags=(SELECT ${searchFlags("m")} FROM messages m WHERE m.rowid=message_search_meta.row_id)`;
