import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { Address } from "./domain.js";
import { ContactGroup, mergeContacts, type ContactSnapshot, type ContactSync } from "./contacts.js";
import { all, run } from "./sql-rows.js";

const SyncRow = Schema.Struct({
  account_id: Schema.String,
  refreshed_at: Schema.NullOr(Schema.Number),
  attempted_at: Schema.Number,
  error: Schema.NullOr(Schema.String),
  scope_missing: Schema.Number,
  count: Schema.Int,
});
export function makeContactStore(sql: SqlClient.SqlClient) {
  return {
    replaceContactExtras: (
      accountId: string,
      snapshot: Pick<ContactSnapshot, "groups" | "photos">,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* run(sql`DELETE FROM contact_groups WHERE account_id=${accountId}`);
            for (const group of snapshot.groups)
              yield* run(
                sql`INSERT INTO contact_groups VALUES (${accountId},${group.id},${group.name},${JSON.stringify(mergeContacts(group.members))})`,
              );
            yield* run(
              sql`DELETE FROM contact_photos WHERE account_id=${accountId} AND address NOT IN (SELECT json_extract(value,'$.address') FROM json_each(${JSON.stringify(snapshot.photos)}))`,
            );
            for (const photo of snapshot.photos)
              yield* run(sql`INSERT INTO contact_photos(account_id,address,url) VALUES (${accountId},${photo.address.toLowerCase()},${photo.url})
            ON CONFLICT(account_id,address) DO UPDATE SET url=excluded.url,
            data_url=CASE WHEN contact_photos.url=excluded.url THEN contact_photos.data_url ELSE NULL END`);
          }),
        )
        .pipe(Effect.orDie),
    contactGroups: (query: string, accountIds?: readonly string[]) =>
      all(
        Schema.Struct({
          account_id: Schema.String,
          id: Schema.String,
          name: Schema.String,
          members_json: Schema.fromJsonString(ContactGroup.fields.members),
        }),
      )(
        sql`SELECT g.* FROM contact_groups g JOIN accounts a ON a.id=g.account_id
        WHERE a.enabled=1 AND instr(lower(g.name),${query.trim().toLowerCase()})>0
        AND (${accountIds === undefined ? 1 : 0}=1 OR g.account_id IN (SELECT value FROM json_each(${JSON.stringify(accountIds ?? [])}))) ORDER BY g.name,g.account_id LIMIT 8`,
      ).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            accountId: row.account_id,
            id: row.id,
            name: row.name,
            members: row.members_json,
          })),
        ),
      ),
    contactPhotoSource: (accountId: string, address: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* all(
              Schema.Struct({ url: Schema.String, data_url: Schema.NullOr(Schema.String) }),
            )(
              sql`SELECT p.url,p.data_url FROM contact_photos p JOIN accounts a ON a.id=p.account_id WHERE a.enabled=1 AND p.account_id=${accountId} AND p.address=${address.trim().toLowerCase()}`,
            );
            const source = rows[0];
            if (!source) return null;
            if (source.data_url)
              yield* run(
                sql`UPDATE contact_photos SET last_used=(SELECT COALESCE(MAX(last_used),0)+1 FROM contact_photos WHERE data_url IS NOT NULL) WHERE account_id=${accountId} AND address=${address.trim().toLowerCase()}`,
              );
            return { url: source.url, dataUrl: source.data_url };
          }),
        )
        .pipe(Effect.orDie),
    cacheContactPhoto: (accountId: string, address: string, url: string, dataUrl: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* run(sql`UPDATE contact_photos SET data_url=${dataUrl}, last_used=(SELECT COALESCE(MAX(last_used),0)+1 FROM contact_photos WHERE data_url IS NOT NULL)
        WHERE account_id=${accountId} AND address=${address.trim().toLowerCase()} AND url=${url}
        AND NOT EXISTS(SELECT 1 FROM prefs WHERE key='contactPhotos' AND value_json='false')`);
            yield* run(sql`WITH recent AS (
        SELECT account_id,address,ROW_NUMBER() OVER (ORDER BY last_used DESC,account_id,address) AS position,
          SUM(length(data_url)) OVER (ORDER BY last_used DESC,account_id,address ROWS UNBOUNDED PRECEDING) AS bytes
        FROM contact_photos WHERE data_url IS NOT NULL
      ) UPDATE contact_photos SET data_url=NULL,last_used=0 WHERE (account_id,address) IN (
        SELECT account_id,address FROM recent WHERE position>128 OR bytes>8388608
      )`);
          }),
        )
        .pipe(Effect.orDie),
    senderHistory: (recipients: readonly string[]) => {
      const addresses = [
        ...new Set(recipients.map((address) => address.trim().toLowerCase()).filter(Boolean)),
      ];
      if (!addresses.length) return Effect.succeed([]);
      return all(
        Schema.Struct({
          account_id: Schema.String,
          from_addr: Schema.String,
          recipient: Schema.String,
          count: Schema.Number,
          last_sent: Schema.Number,
        }),
      )(
        sql`SELECT s.account_id,s.from_addr,s.address AS recipient,COUNT(*) AS count,MAX(s.sent_at) AS last_sent
          FROM sent_recipients s JOIN accounts a ON a.id=s.account_id
          WHERE a.enabled=1 AND s.address IN (SELECT value FROM json_each(${JSON.stringify(addresses)}))
          GROUP BY s.account_id,s.from_addr,s.address ORDER BY last_sent DESC LIMIT 500`,
      ).pipe(
        Effect.map((rows) =>
          rows.map((r) => ({
            accountId: r.account_id,
            address: r.from_addr,
            recipient: r.recipient,
            count: r.count,
            lastSent: r.last_sent,
          })),
        ),
      );
    },
    contactAlternatives: (address: string) =>
      all(Address)(sql`
      SELECT DISTINCT c.address,c.name FROM server_contacts c
      WHERE c.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND c.contact_key!=''
        AND EXISTS(SELECT 1 FROM server_contacts original WHERE original.account_id=c.account_id
          AND original.contact_key=c.contact_key AND original.address=${address.trim().toLowerCase()})
      ORDER BY c.address LIMIT 50`),
    knownSenders: (accountId: string, addresses: readonly string[]) =>
      all(Schema.Struct({ address: Schema.String }))(
        sql`SELECT candidate.value AS address
          FROM json_each(${JSON.stringify([...new Set(addresses.map((address) => address.trim().toLowerCase()))])}) candidate
          WHERE EXISTS(SELECT 1 FROM server_contacts c WHERE c.account_id=${accountId} AND c.address=candidate.value)
            OR EXISTS(SELECT 1 FROM mailed_addresses a WHERE a.account_id=${accountId} AND a.address=candidate.value)
            OR EXISTS(SELECT 1 FROM accounts a WHERE a.id=${accountId} AND lower(a.email)=candidate.value)`,
      ).pipe(Effect.map((rows) => rows.map((r) => r.address))),
    rememberMailedAddresses: (accountId: string, addresses: readonly string[]) =>
      run(
        sql`INSERT OR IGNORE INTO mailed_addresses(account_id,address)
        SELECT ${accountId}, lower(trim(value)) FROM json_each(${JSON.stringify(addresses)})
        WHERE trim(value)!=''`,
      ),
    replaceServerContacts: Effect.fn("Store.replaceServerContacts")(function* (
      accountId: string,
      contacts: readonly Address[],
      now: number,
    ) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* run(sql`DELETE FROM server_contacts WHERE account_id = ${accountId}`);
            yield* run(sql`DELETE FROM contact_organizations WHERE account_id=${accountId}`);
            for (const a of mergeContacts(contacts)) {
              if (a.company?.trim())
                yield* run(
                  sql`INSERT INTO contact_organizations(account_id,address,company) VALUES(${accountId},${a.address},${a.company.trim()})`,
                );
              yield* run(
                sql`INSERT INTO server_contacts (account_id, address, name, contact_key) VALUES (${accountId}, ${a.address}, ${a.name}, ${a.contactKey ?? ""})`,
              );
            }
            yield* run(sql`INSERT INTO contact_sync (account_id, refreshed_at, attempted_at, error, scope_missing)
          VALUES (${accountId}, ${now}, ${now}, NULL, 0) ON CONFLICT(account_id) DO UPDATE SET
          refreshed_at=excluded.refreshed_at, attempted_at=excluded.attempted_at, error=NULL, scope_missing=0`);
          }),
        )
        .pipe(Effect.orDie);
    }),
    contactSync: all(SyncRow)(
      sql`SELECT s.*, (SELECT COUNT(*) FROM server_contacts c WHERE c.account_id=s.account_id) AS count FROM contact_sync s ORDER BY s.account_id`,
    ).pipe(
      Effect.map((rows): ContactSync[] =>
        rows.map((r) => ({
          accountId: r.account_id,
          refreshedAt: r.refreshed_at,
          attemptedAt: r.attempted_at,
          error: r.error,
          scopeMissing: r.scope_missing === 1,
          count: r.count,
        })),
      ),
    ),
    setContactSyncError: (accountId: string, now: number, error: string, scopeMissing: boolean) =>
      run(sql`INSERT INTO contact_sync (account_id, attempted_at, error, scope_missing) VALUES (${accountId}, ${now}, ${error}, ${scopeMissing ? 1 : 0})
      ON CONFLICT(account_id) DO UPDATE SET attempted_at=excluded.attempted_at, error=excluded.error, scope_missing=excluded.scope_missing`),
  };
}
