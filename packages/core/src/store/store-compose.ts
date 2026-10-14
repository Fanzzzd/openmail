import { makeOutboxStore } from "../mailbox/mobile-outbox.js";
import { makeRemoteAccessStore } from "../app/remote-access.js";
import { PlatformCrypto } from "../platform/crypto.js";
import { makeSignatureStore } from "./store-signatures.js";
import { signatureDefault } from "../compose/signatures.js";
/**
 * The Store's SQL for writing and reading settings: drafts, preferences,
 * signatures, templates, recipient suggestions and the remote image allowlist. Part of the Store service (store.ts
 * spreads these into it); split out to keep each file readable.
 */
import { Clock, Context, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { Address } from "../domain/message.js";
import { excludedAddresses } from "../contacts/contacts.js";
import {
  DEFAULT_PREFS,
  Prefs,
  PrefsPatch,
  ToolbarAction,
  LEGACY_TOOLBAR_ACTIONS,
  type Signature,
  SignatureKind,
  type Template,
  type TemplateInput,
} from "../domain/prefs.js";
import { NotFound } from "../domain/errors.js";
import { imageSenderKey } from "../reader/reading.js";
import { richComposeBody, textComposeHtml } from "../compose/compose-body.js";
import { all, first, run } from "./sql-rows.js";
import { makeDraftStore } from "./store-drafts.js";

const PrefRow = Schema.Struct({ key: Schema.String, value_json: Schema.String });
const SignatureRow = Schema.Struct({
  address: Schema.String,
  kind: SignatureKind,
  text: Schema.String,
});
const TemplateRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  subject: Schema.String,
  to_json: Schema.fromJsonString(Schema.Array(Address)),
  cc_json: Schema.fromJsonString(Schema.Array(Address)),
  bcc_json: Schema.fromJsonString(Schema.Array(Address)),
  body: Schema.String,
  updated_at: Schema.Number,
});
const ContactRow = Schema.Struct({ address: Schema.String, name: Schema.NullOr(Schema.String) });
const AddressRow = Schema.Struct({ address: Schema.String });
const EntryRow = Schema.Struct({ entry: Schema.String });

function toTemplate(r: typeof TemplateRow.Type): Template {
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    to: r.to_json,
    cc: r.cc_json,
    bcc: r.bcc_json,
    body: r.body,
    updatedAt: r.updated_at,
  };
}

/** One stored preference, or the default when it is missing or no longer valid. */
function pref<A, I>(schema: Schema.Codec<A, I>, raw: string | undefined, fallback: A): A {
  if (raw === undefined) return fallback;
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(schema))(raw),
    () => fallback,
  );
}

function storedValue<A, I>(schema: Schema.Codec<A, I>, value: unknown, fallback: A): A {
  return Option.getOrElse(Schema.decodeUnknownOption(schema)(value), () => fallback);
}

/** Suggestions lose half their weight after this many milliseconds (30 days). */
const MONTH = 30 * 86_400_000;

export function makeComposeStore(
  sql: SqlClient.SqlClient,
  crypto: PlatformCrypto = Context.get(Context.empty(), PlatformCrypto),
) {
  const drafts = makeDraftStore(sql);

  // Preferences

  const prefs = all(PrefRow)(
    sql`SELECT key, value_json FROM prefs WHERE key NOT LIKE 'mobile-outbox:%' AND key NOT LIKE 'mobile-background:%'`,
  ).pipe(
    Effect.map((rows): Prefs => {
      const stored = new Map(rows.map((r) => [r.key, r.value_json]));
      const f = Prefs.fields;
      const d = DEFAULT_PREFS;
      // Older builds stored a boolean; true loaded remote images in every message.
      // Only a missing row gets the default. An unreadable one fails closed to "ask".
      const storedImages = stored.get("remoteImages");
      const remoteImages =
        storedImages === undefined
          ? d.remoteImages
          : pref(Schema.Union([f.remoteImages, Schema.Boolean]), storedImages, "ask");
      const labs = pref(Schema.Record(Schema.String, Schema.Unknown), stored.get("labs"), {});
      const swipes = pref(
        Schema.Record(Schema.String, Schema.Unknown),
        stored.get("swipeActions"),
        {},
      );
      return {
        spellcheck: pref(f.spellcheck, stored.get("spellcheck"), d.spellcheck),
        spellcheckLanguages: pref(
          f.spellcheckLanguages,
          stored.get("spellcheckLanguages"),
          d.spellcheckLanguages,
        ),
        defaultProfilesPrompted: pref(
          f.defaultProfilesPrompted,
          stored.get("defaultProfilesPrompted"),
          d.defaultProfilesPrompted,
        ),
        bodyCacheBytes: pref(f.bodyCacheBytes, stored.get("bodyCacheBytes"), d.bodyCacheBytes),
        totalCacheBytes: pref(f.totalCacheBytes, stored.get("totalCacheBytes"), d.totalCacheBytes),
        attachmentCacheBytes: pref(
          f.attachmentCacheBytes,
          stored.get("attachmentCacheBytes"),
          d.attachmentCacheBytes,
        ),
        signaturePosition: pref(
          f.signaturePosition,
          stored.get("signaturePosition"),
          d.signaturePosition,
        ),
        signatureSeparator: pref(
          f.signatureSeparator,
          stored.get("signatureSeparator"),
          d.signatureSeparator,
        ),
        signatureOrder: pref(f.signatureOrder, stored.get("signatureOrder"), d.signatureOrder),
        contactPhotos: pref(f.contactPhotos, stored.get("contactPhotos"), d.contactPhotos),
        useAppleContacts: pref(
          f.useAppleContacts,
          stored.get("useAppleContacts"),
          d.useAppleContacts,
        ),
        composeFormatBar: pref(
          f.composeFormatBar,
          stored.get("composeFormatBar"),
          d.composeFormatBar,
        ),
        composeMarkdownReplacement: pref(
          f.composeMarkdownReplacement,
          stored.get("composeMarkdownReplacement"),
          d.composeMarkdownReplacement,
        ),
        composeSmartLists: pref(
          f.composeSmartLists,
          stored.get("composeSmartLists"),
          d.composeSmartLists,
        ),
        emojiReplacement: pref(
          f.emojiReplacement,
          stored.get("emojiReplacement"),
          d.emojiReplacement,
        ),
        inlineImageSize: pref(f.inlineImageSize, stored.get("inlineImageSize"), d.inlineImageSize),
        composeFont: pref(f.composeFont, stored.get("composeFont"), d.composeFont),
        updateChannel: pref(f.updateChannel, stored.get("updateChannel"), d.updateChannel),
        updateAutoDownload: pref(
          f.updateAutoDownload,
          stored.get("updateAutoDownload"),
          d.updateAutoDownload,
        ),
        labs: {
          markdown: storedValue(f.labs.fields.markdown, labs.markdown, d.labs.markdown),
          calendarDetection: storedValue(
            f.labs.fields.calendarDetection,
            labs.calendarDetection,
            d.labs.calendarDetection,
          ),
        },
        swipeActions: {
          leftShort: storedValue(
            f.swipeActions.fields.leftShort,
            swipes.leftShort,
            d.swipeActions.leftShort,
          ),
          leftLong: storedValue(
            f.swipeActions.fields.leftLong,
            swipes.leftLong,
            d.swipeActions.leftLong,
          ),
          rightShort: storedValue(
            f.swipeActions.fields.rightShort,
            swipes.rightShort,
            d.swipeActions.rightShort,
          ),
          rightLong: storedValue(
            f.swipeActions.fields.rightLong,
            swipes.rightLong,
            d.swipeActions.rightLong,
          ),
        },
        toolbarActions: currentToolbarOrder(
          [
            ...new Set(
              pref(
                Schema.Array(Schema.Unknown),
                stored.get("toolbarActions"),
                d.toolbarActions,
              ).flatMap((item) => {
                const decoded = Schema.decodeUnknownOption(ToolbarAction)(item);
                return Option.isSome(decoded) ? [decoded.value] : [];
              }),
            ),
          ],
          d.toolbarActions,
        ),
        messageListDensity: pref(
          f.messageListDensity,
          stored.get("messageListDensity"),
          d.messageListDensity,
        ),
        specialFolderBadges: pref(
          f.specialFolderBadges,
          stored.get("specialFolderBadges"),
          d.specialFolderBadges,
        ),
        showMore: pref(f.showMore, stored.get("showMore"), d.showMore),
        remoteImages:
          remoteImages === true ? "always" : remoteImages === false ? "ask" : remoteImages,
        remoteImagesChosen: stored.has("remoteImages"),
        cleanLinks: pref(Schema.Boolean, stored.get("cleanLinks"), true),
        undoSendSeconds: pref(f.undoSendSeconds, stored.get("undoSendSeconds"), d.undoSendSeconds),
        replyFrom: pref(f.replyFrom, stored.get("replyFrom"), d.replyFrom),
        quoteSelection: pref(f.quoteSelection, stored.get("quoteSelection"), d.quoteSelection),
        defaultFrom: pref(f.defaultFrom, stored.get("defaultFrom"), d.defaultFrom),
        showFullRecipientAddresses: pref(
          f.showFullRecipientAddresses,
          stored.get("showFullRecipientAddresses"),
          d.showFullRecipientAddresses,
        ),
        language: pref(f.language, stored.get("language"), d.language),
        markReadDelay: pref(f.markReadDelay, stored.get("markReadDelay"), d.markReadDelay),
        nextSelection: pref(f.nextSelection, stored.get("nextSelection"), d.nextSelection),
        deleteKeyAction: pref(f.deleteKeyAction, stored.get("deleteKeyAction"), d.deleteKeyAction),
        readingPanePosition: pref(
          f.readingPanePosition,
          stored.get("readingPanePosition"),
          d.readingPanePosition,
        ),
        sidebarVisible: pref(f.sidebarVisible, stored.get("sidebarVisible"), d.sidebarVisible),
        toolbarVisible: pref(f.toolbarVisible, stored.get("toolbarVisible"), d.toolbarVisible),
        readingPaneVisible: pref(
          f.readingPaneVisible,
          stored.get("readingPaneVisible"),
          d.readingPaneVisible,
        ),
        readerZoom: pref(f.readerZoom, stored.get("readerZoom"), d.readerZoom),
        messageBackground: pref(
          f.messageBackground,
          stored.get("messageBackground"),
          d.messageBackground,
        ),
        attachmentSaveFolder: pref(
          f.attachmentSaveFolder,
          stored.get("attachmentSaveFolder"),
          d.attachmentSaveFolder,
        ),
        attachmentOpenFolder: pref(
          f.attachmentOpenFolder,
          stored.get("attachmentOpenFolder"),
          "internal",
        ),
        threadGrouping: pref(f.threadGrouping, stored.get("threadGrouping"), d.threadGrouping),
        threadOrder: pref(f.threadOrder, stored.get("threadOrder"), d.threadOrder),
        shortcutSet: pref(f.shortcutSet, stored.get("shortcutSet"), d.shortcutSet),
        showAccountLabels: pref(
          f.showAccountLabels,
          stored.get("showAccountLabels"),
          d.showAccountLabels,
        ),
        notificationActions: pref(
          f.notificationActions,
          stored.get("notificationActions"),
          d.notificationActions,
        ),
        notifications: pref(f.notifications, stored.get("notifications"), d.notifications),
        quietHours: pref(f.quietHours, stored.get("quietHours"), d.quietHours),
        activeHours: pref(f.activeHours, stored.get("activeHours"), d.activeHours),
        menuBarUnreadCount: pref(
          f.menuBarUnreadCount,
          stored.get("menuBarUnreadCount"),
          d.menuBarUnreadCount,
        ),
      };
    }),
    Effect.withSpan("Store.prefs"),
  );

  const setPrefs = Effect.fn("Store.setPrefs")(function* (patch: PrefsPatch) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const [key, value] of Object.entries(patch)) {
            // Derived from the stored mode; a row would only drift from it.
            if (key === "remoteImagesChosen") continue;
            yield* run(sql`INSERT INTO prefs (key, value_json) VALUES (${key}, ${JSON.stringify(value)})
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
          }
          if (patch.contactPhotos === false)
            yield* run(
              sql`UPDATE contact_photos SET data_url=NULL,last_used=0 WHERE data_url IS NOT NULL`,
            );
        }),
      )
      .pipe(Effect.orDie);
  });

  // Signatures

  const legacySignatures = all(SignatureRow)(
    sql`SELECT address, kind, text FROM (SELECT address, kind, text,
      ROW_NUMBER() OVER (PARTITION BY address, kind ORDER BY source = 'local' DESC) AS rank
      FROM signatures) WHERE rank=1 ORDER BY address, kind`,
  ).pipe(
    Effect.map((rows): Signature[] => [...rows]),
    Effect.withSpan("Store.signatures"),
  );

  const signatures = Effect.gen(function* () {
    const legacy = yield* legacySignatures;
    const library = makeSignatureStore(sql, crypto);
    const named = yield* library.namedSignatures;
    const defaults = yield* library.signatureDefaults;
    const addresses = new Set([
      ...legacy.map((s) => s.address),
      ...named.map((s) => s.address),
      ...defaults.map((s) => s.address),
    ]);
    const result: Signature[] = [];
    for (const address of addresses)
      for (const kind of ["new", "reply"] as const) {
        const selected = signatureDefault(named, defaults, address, kind);
        const choice = defaults.find((s) => s.address === address && s.kind === kind);
        if (selected) result.push({ address, kind, text: selected.text, html: selected.html });
        else if (!choice) {
          const old = legacy.find((s) => s.address === address && s.kind === kind);
          if (old) result.push(old);
        }
      }
    return result;
  });

  const setSignature = Effect.fn("Store.setSignature")(function* (s: Signature) {
    const address = s.address.trim().toLowerCase();
    const id = `legacy:${address}:${s.kind}`;
    const body = richComposeBody(s.html ?? textComposeHtml(s.text));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (body.text.trim()) {
            yield* run(
              sql`INSERT INTO signatures(address,kind,source,text) VALUES(${address},${s.kind},'local',${body.text}) ON CONFLICT(address,kind,source) DO UPDATE SET text=excluded.text`,
            );
            yield* run(
              sql`INSERT INTO named_signatures(id,address,name,text,html) VALUES(${id},${address},${s.kind === "new" ? "New messages" : "Replies"},${body.text},${body.html}) ON CONFLICT(id) DO UPDATE SET text=excluded.text,html=excluded.html`,
            );
            yield* run(
              sql`INSERT INTO signature_defaults(address,kind,signature_id) VALUES(${address},${s.kind},${id}) ON CONFLICT(address,kind) DO UPDATE SET signature_id=excluded.signature_id`,
            );
          } else {
            yield* run(
              sql`DELETE FROM signatures WHERE address=${address} AND kind=${s.kind} AND source='local'`,
            );
            yield* run(sql`DELETE FROM named_signatures WHERE id=${id}`);
            yield* run(sql`DELETE FROM signature_defaults WHERE signature_id=${id}`);
          }
        }),
      )
      .pipe(Effect.orDie);
  });

  // Templates

  const TEMPLATE_COLUMNS = sql.literal(
    "id, name, subject, to_json, cc_json, bcc_json, body, updated_at",
  );

  const templates = all(TemplateRow)(
    sql`SELECT ${TEMPLATE_COLUMNS} FROM templates ORDER BY name COLLATE NOCASE, id`,
  ).pipe(
    Effect.map((rows) => rows.map(toTemplate)),
    Effect.withSpan("Store.templates"),
  );

  const saveTemplate = Effect.fn("Store.saveTemplate")(function* (
    id: string | null,
    input: TemplateInput,
  ): Effect.fn.Return<Template, NotFound> {
    const now = yield* Clock.currentTimeMillis;
    const key = id ?? crypto.randomUUID();
    const values = {
      name: input.name.trim(),
      subject: input.subject,
      to: JSON.stringify(input.to),
      cc: JSON.stringify(input.cc),
      bcc: JSON.stringify(input.bcc ?? []),
      body: input.body,
    };
    const row = yield* first(TemplateRow)(
      id === null
        ? sql`INSERT INTO templates (id, name, subject, to_json, cc_json, bcc_json, body, updated_at)
            VALUES (${key}, ${values.name}, ${values.subject}, ${values.to}, ${values.cc}, ${values.bcc},
              ${values.body}, ${now}) RETURNING ${TEMPLATE_COLUMNS}`
        : sql`UPDATE templates SET name = ${values.name}, subject = ${values.subject},
            to_json = ${values.to}, cc_json = ${values.cc}, bcc_json = ${values.bcc}, body = ${values.body},
            updated_at = ${now} WHERE id = ${key} RETURNING ${TEMPLATE_COLUMNS}`,
    );
    if (Option.isNone(row)) return yield* new NotFound({ what: "template", id: key });
    return toTemplate(row.value);
  });

  const deleteTemplate = Effect.fn("Store.deleteTemplate")((id: string) =>
    run(sql`DELETE FROM templates WHERE id = ${id}`),
  );

  // Contacts

  /**
   * Everyone the person wrote to (weight 3 in To, 2 in Cc) or heard from
   * (weight 1), each occurrence discounted by age: weight / (1 + age / 30
   * days). Frequency and recency add up in one score.
   */
  const CONTACT_MATCH_WINDOW = 5000;
  const suggestContacts = Effect.fn("Store.suggestContacts")(function* (
    query: string,
    limit: number,
    exclude?: string | readonly string[],
    accountIds?: readonly string[],
  ) {
    if (accountIds?.length === 0) return [];
    const excluded = excludedAddresses(exclude);

    const now = yield* Clock.currentTimeMillis;
    const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (query.trim() && tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token}"*`).join(" AND ");
    // A short prefix can match every message's sender. The newest occurrences
    // carry the recency-weighted score, so a bounded window keeps typing fast.
    const matching = tokens.length
      ? sql`c.rowid IN (SELECT rowid FROM contact_completion_fts WHERE contact_completion_fts MATCH ${match} ORDER BY rowid DESC LIMIT ${CONTACT_MATCH_WINDOW})`
      : sql.literal("1");
    const scope = (alias: "c" | "h") =>
      sql.and([
        sql`${sql.literal(`${alias}.account_id`)} IN (SELECT id FROM accounts WHERE enabled=1)`,
        accountIds === undefined
          ? sql`1`
          : sql`${sql.literal(`${alias}.account_id`)} IN ${sql.in(accountIds)}`,
      ]);
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.min(100, Math.trunc(limit)))
      : 10;
    const rows = yield* all(ContactRow)(sql`
      WITH matched AS (
        SELECT c.* FROM contact_candidates c WHERE ${scope("c")}
          AND ${matching}
      ), scored AS MATERIALIZED (
        SELECT address,SUM(CASE WHEN source!=3 THEN weight / (1.0 + MAX(${now}-date,0)/(${MONTH}*1.0)) ELSE 0 END) + MAX(CASE WHEN source=3 THEN 0.2 ELSE 0 END) AS score FROM matched GROUP BY address
      )
      SELECT s.address, (SELECT NULLIF(h.name,'') FROM contact_candidates h
        WHERE h.address=s.address AND h.name!='' AND ${scope("h")}
        ORDER BY h.source DESC,h.date DESC,h.account_id,h.id LIMIT 1) AS name
      FROM scored s
      WHERE s.address LIKE '%@%' AND s.address NOT IN ${sql.in(excluded.length ? excluded : [""])}
        AND NOT EXISTS(SELECT 1 FROM hidden_contacts hidden WHERE hidden.address=s.address)
        AND s.address NOT LIKE '%noreply%' AND s.address NOT LIKE '%no-reply%' AND s.address NOT LIKE '%donotreply%'
      ORDER BY s.score DESC,s.address LIMIT ${boundedLimit}`);

    return rows.map((r): Address => ({ name: r.name ?? "", address: r.address }));
  });

  const hiddenContacts = all(AddressRow)(
    sql`SELECT address FROM hidden_contacts ORDER BY address`,
  ).pipe(
    Effect.map((rows) => rows.map((r) => r.address)),
    Effect.withSpan("Store.hiddenContacts"),
  );

  const setContactHidden = Effect.fn("Store.setContactHidden")((
    address: string,
    hidden: boolean,
  ) => {
    const key = address.trim().toLowerCase();
    return hidden
      ? run(sql`INSERT INTO hidden_contacts (address) VALUES (${key}) ON CONFLICT DO NOTHING`)
      : run(sql`DELETE FROM hidden_contacts WHERE address = ${key}`);
  });

  // Remote images

  const imageSenders = all(EntryRow)(sql`SELECT entry FROM image_senders ORDER BY entry`).pipe(
    Effect.map((rows) => rows.map((r) => r.entry)),
    Effect.withSpan("Store.imageSenders"),
  );

  const setImageSender = Effect.fn("Store.setImageSender")(function* (
    entry: string,
    allowed: boolean,
  ) {
    const key = imageSenderKey(entry);
    if (!key) return;
    if (!allowed) {
      yield* run(sql`DELETE FROM image_senders WHERE entry = ${key}`);
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* run(sql`INSERT INTO image_senders (entry, created_at) VALUES (${key}, ${now})
      ON CONFLICT DO NOTHING`);
  });

  const claimOnce = (marker: string) =>
    all(Schema.Struct({ key: Schema.String }))(
      sql`INSERT INTO prefs (key,value_json) VALUES (${marker},'true')
        ON CONFLICT(key) DO NOTHING RETURNING key`,
    ).pipe(Effect.map((rows) => rows.length > 0));

  return {
    ...drafts,
    claimOnce,
    imageSenders,
    setImageSender,
    ...makeOutboxStore(sql),
    ...makeRemoteAccessStore(sql),
    prefs,
    setPrefs,
    signatures,
    setSignature,
    templates,
    saveTemplate,
    deleteTemplate,
    suggestContacts,
    hiddenContacts,
    setContactHidden,
  };
}

/** A stored toolbar equal to the old default was never customised: it gets the current default. */
function currentToolbarOrder(
  stored: readonly ToolbarAction[],
  current: readonly ToolbarAction[],
): readonly ToolbarAction[] {
  return stored.length === LEGACY_TOOLBAR_ACTIONS.length &&
    stored.every((action, index) => action === LEGACY_TOOLBAR_ACTIONS[index])
    ? current
    : stored;
}
