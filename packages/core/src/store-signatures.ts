import { PlatformCrypto } from "./platform/crypto.js";
import { Context, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import {
  NamedSignature,
  SignatureDefault,
  gmailSignatureId,
  type NamedSignatureInput,
} from "./signatures.js";
import { richComposeBody, textComposeHtml } from "./compose-body.js";
import { all, first, run } from "./sql-rows.js";
import { InvalidInput, NotFound } from "./domain/errors.js";

export function makeSignatureStore(
  sql: SqlClient.SqlClient,
  crypto: PlatformCrypto = Context.get(Context.empty(), PlatformCrypto),
) {
  const namedSignatures = Effect.gen(function* () {
    const local = yield* all(NamedSignature)(
      sql`SELECT id,address,name,text,html,'local' AS source FROM named_signatures
      UNION ALL SELECT 'legacy:'||address||':'||kind,address,CASE kind WHEN 'new' THEN 'New messages' ELSE 'Replies' END,text,'','local'
        FROM signatures s WHERE source='local' AND NOT EXISTS(SELECT 1 FROM named_signatures n WHERE n.id='legacy:'||s.address||':'||s.kind)
      ORDER BY name COLLATE NOCASE,id`,
    );
    const gmail = yield* all(
      Schema.Struct({
        address: Schema.String,
        signature: Schema.String,
        signature_html: Schema.String,
      }),
    )(
      sql`SELECT address,signature,signature_html FROM send_as WHERE signature!='' GROUP BY address ORDER BY address`,
    );
    return [
      ...local.map((s) => ({
        ...s,
        html: richComposeBody(s.html || textComposeHtml(s.text)).html,
      })),
      ...gmail.map((s): NamedSignature => {
        const body = richComposeBody(s.signature_html || textComposeHtml(s.signature));
        return {
          id: gmailSignatureId(s.address),
          address: s.address,
          name: "Gmail",
          source: "gmail",
          text: body.text,
          html: body.html,
        };
      }),
    ];
  });
  const signatureDefaults = all(SignatureDefault)(
    sql`SELECT address,kind,signature_id AS signatureId FROM signature_defaults ORDER BY address,kind`,
  );
  const saveNamedSignature = Effect.fn("Store.saveNamedSignature")(function* (
    input: NamedSignatureInput,
    id?: string,
  ): Effect.fn.Return<NamedSignature, NotFound | InvalidInput> {
    const address = input.address.trim().toLowerCase();
    const name = input.name.trim();
    if (!name || !address)
      return yield* new InvalidInput({ message: "A signature needs a name and sending address" });
    const body = richComposeBody(input.html ?? textComposeHtml(input.text));
    const key = id ?? crypto.randomUUID();
    // Recovery from older schemas may restore legacy rows without the new library table's rows.
    if (id !== undefined)
      yield* run(sql`INSERT OR IGNORE INTO named_signatures(id,address,name,text,html)
      SELECT 'legacy:'||address||':'||kind,address,${name},text,'' FROM signatures
      WHERE source='local' AND address=${address} AND 'legacy:'||address||':'||kind=${id}`);
    const row = yield* first(NamedSignature)(
      id === undefined
        ? sql`INSERT INTO named_signatures(id,address,name,text,html) VALUES(${key},${address},${name},${body.text},${body.html}) RETURNING *, 'local' AS source`
        : sql`UPDATE named_signatures SET name=${name},text=${body.text},html=${body.html} WHERE id=${key} AND address=${address} RETURNING *, 'local' AS source`,
    );
    if (row._tag === "None") return yield* new NotFound({ what: "signature", id: key });
    return row.value;
  });
  const deleteNamedSignature = (id: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* run(sql`DELETE FROM signature_defaults WHERE signature_id=${id}`);
          yield* run(sql`DELETE FROM named_signatures WHERE id=${id}`);
          yield* run(
            sql`DELETE FROM signatures WHERE source='local' AND 'legacy:'||address||':'||kind=${id}`,
          );
        }),
      )
      .pipe(Effect.orDie);
  const setSignatureDefault = Effect.fn("Store.setSignatureDefault")(function* (
    setting: SignatureDefault,
  ) {
    const address = setting.address.trim().toLowerCase();
    if (
      setting.signatureId !== null &&
      !(yield* namedSignatures).some((s) => s.id === setting.signatureId && s.address === address)
    )
      return yield* new InvalidInput({
        message: "The signature belongs to another sending address or is unavailable",
      });
    return yield* run(
      sql`INSERT INTO signature_defaults(address,kind,signature_id) VALUES(${address},${setting.kind},${setting.signatureId}) ON CONFLICT(address,kind) DO UPDATE SET signature_id=excluded.signature_id`,
    );
  });
  return {
    namedSignatures,
    signatureDefaults,
    saveNamedSignature,
    deleteNamedSignature,
    setSignatureDefault,
  };
}
