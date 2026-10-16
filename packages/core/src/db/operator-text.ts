/**
 * The text that to:, cc:, filename: and list: search, one row per message in
 * message_operator_text. Migration 57 embeds this SQL in its triggers, and the background
 * backfill (store-word-index.ts) runs the same SQL over older rows, so it never changes here; a
 * new rule needs a new migration. migrations.test.ts pins the migration text.
 *
 * Each column joins its values with char(30), and a name and address with char(31) between
 * them. A LIKE pattern without those characters matches inside one value only, as the json_each
 * test it replaces does. json_valid and the type guards skip malformed JSON instead of failing the
 * write.
 */
export const OPERATOR_TEXT_SEPARATORS = ["\u001e", "\u001f"] as const;

const addresses = (column: string) =>
  `COALESCE((SELECT group_concat(COALESCE(json_extract(value,'$.name'),'') || char(31) || COALESCE(json_extract(value,'$.address'),''), char(30)) FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) WHERE type='object'),'')`;
const header = (column: string, name: string) =>
  `COALESCE((SELECT group_concat(COALESCE(json_extract(h.value,'$.value'),''), char(30)) FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) h WHERE h.type='object' AND lower(json_extract(h.value,'$.name'))='${name}'),'')`;

/** to_text, cc_text, file_text, list_id_text and list_post_text of the row `row` names. */
export const operatorTextValues = (row: "new" | "m") =>
  [
    addresses(`${row}.to_json`),
    addresses(`${row}.cc_json`),
    `COALESCE((SELECT group_concat(COALESCE(json_extract(value,'$.filename'),''), char(30)) FROM json_each(CASE WHEN json_valid(${row}.attachments_json) THEN ${row}.attachments_json ELSE '[]' END) WHERE type='object'),'')`,
    header(`${row}.headers_json`, "list-id"),
    header(`${row}.headers_json`, "list-post"),
  ].join(",\n       ");
