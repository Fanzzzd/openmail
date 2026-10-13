import { Effect, Option, Predicate } from "effect";
import type { DraftRemote, OutgoingMessage } from "../../../domain/changes.js";
import { PermanentError, ProviderError } from "../../../domain/errors.js";
import { decodeProviderId, encodeProviderId } from "../../../providers/imap/imap-cursor.js";
import { serverSavesSent } from "../../../providers/imap/imap-settings.js";
import { confirmDelivery } from "../../../providers/provider-send.js";
import type {
  DraftPush,
  ProviderAdapter,
  ProviderPushContext,
} from "../../../providers/adapter.js";
import { buildMime } from "../compose.js";

import {
  MailCodec,
  mimeAddresses,
  type MailCodecPort,
  type MimeMessage,
} from "../../mail-codec.js";
import { deleteMessage, ensureFolder, openFolderOf } from "./ops.js";
import { parseHeaders, stripBcc } from "./parse.js";
import type { ImapPool } from "./pool.js";
import {
  call,
  describe,
  failure,
  isAuthFailure,
  searchUids,
  smtpTransport,
  type Session,
} from "./session.js";

/** Message-ID and References of the original, read from IMAP. Empty when it moved or is gone. */
const threadingOf = (s: Session, providerId: string) =>
  Option.match(decodeProviderId(providerId), {
    onNone: () => Effect.succeed({}),
    onSome: (ref) =>
      Effect.gen(function* () {
        const mailbox = yield* call(s, (c) => c.mailboxOpen(ref.path, { readOnly: true }));
        if (String(mailbox.uidValidity) !== ref.uidValidity) return {};
        const m = yield* call(s, (c) =>
          c.fetchOne(
            String(ref.uid),
            { uid: true, headers: ["message-id", "references"] },
            { uid: true },
          ),
        );
        if (!m || !m.headers) return {};
        const headers = parseHeaders(m.headers);
        const messageId = headers.get("message-id");
        const references = headers.get("references");
        return { ...(messageId ? { messageId } : {}), ...(references ? { references } : {}) };
      }).pipe(Effect.catchTag("ProviderError", () => Effect.succeed({}))),
  });

/**
 * Files the sent message in Sent. Servers that save SMTP mail themselves get
 * a few seconds to do it first, so Sent never holds two copies.
 */
const saveSent = Effect.fnUntraced(function* (
  s: Session,
  raw: Buffer,
  serverSaves: boolean,
  observed: Set<string>,
) {
  const list = yield* call(s, (c) => c.list());
  const sent = yield* ensureFolder(s, list, "\\Sent", "Sent");
  const messageId = parseHeaders(raw).get("message-id");
  if (messageId) {
    for (let attempt = 0; attempt < (serverSaves ? 4 : 1); attempt++) {
      if (attempt) yield* Effect.sleep("4 seconds");
      yield* call(s, (c) => c.mailboxOpen(sent, { readOnly: true }));
      const found = yield* searchUids(s, { header: { "message-id": messageId } });
      if (found.length) {
        observed.add(s.accountId);
        return;
      }
    }
  }
  const appended = yield* call(s, (c) => c.append(sent, raw, ["\\Seen"]));
  if (!appended) yield* new ProviderError({ message: "Appending the message to Sent failed" });
});

/** UIDVALIDITY and UID are numbers; folder paths retain their exact case. */
const canonicalImapId = (id: string) =>
  Option.map(decodeProviderId(id), (ref) =>
    encodeProviderId(ref.path, BigInt(ref.uidValidity), ref.uid),
  );

const sameImapId = (left: string, right: string) => {
  const a = canonicalImapId(left),
    b = canonicalImapId(right);
  return Option.isSome(a) && Option.isSome(b) && a.value === b.value;
};

const preservedDraftFlags = (flags: Set<string> | undefined) =>
  [...(flags ?? [])].filter(
    (flag) => !["\\Deleted", "\\Recent", "\\Draft", "\\Seen"].includes(flag),
  );

/** Compare editable MIME content; Date, boundary and transport headers can change on retry. */
const draftContent = (mime: MimeMessage) => ({
  subject: mime.subject ?? "",
  text: mime.text ?? "",
  html: mime.html || "",
  from: mimeAddresses(mime.from),
  to: mimeAddresses(mime.to),
  cc: mimeAddresses(mime.cc),
  bcc: mimeAddresses(mime.bcc),
  replyTo: mimeAddresses(mime.replyTo),
  inReplyTo: mime.inReplyTo,
  references: mime.references,
  markdown: mime.headers.get("x-openmail-markdown"),
  markdownSource: mime.headers.get("x-openmail-markdown-source-sha256"),
});

const sameDraftContent = async (
  codec: MailCodecPort,
  current: Uint8Array,
  requested: Uint8Array,
) => {
  const options = { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true };
  const [old, next] = await Promise.all([
    codec.parse(current, options),
    codec.parse(requested, options),
  ]);
  if (
    JSON.stringify(draftContent(old)) !== JSON.stringify(draftContent(next)) ||
    old.attachments.length !== next.attachments.length
  )
    return false;
  return old.attachments.every((part, index) => {
    const other = next.attachments[index];
    return (
      other !== undefined &&
      part.filename === other.filename &&
      part.contentType === other.contentType &&
      part.cid === other.cid &&
      part.contentId === other.contentId &&
      part.related === other.related &&
      part.content.length === other.content.length &&
      part.content.every((byte, offset) => byte === other.content[offset])
    );
  });
};

/**
 * Files the draft in Drafts with the \Draft flag and removes the copy it
 * replaces; IMAP messages cannot be edited in place. The new UID comes from
 * UIDPLUS, or from a search by Message-ID on servers without it.
 */
const appendDraft = Effect.fnUntraced(function* (
  s: Session,
  raw: Buffer,
  previous: string | null,
  organization: OutgoingMessage["draftOrganization"],
  context: ProviderPushContext | undefined,
  codec: MailCodecPort,
) {
  let preservedFlags: string[] = [];
  if (previous && organization === undefined) {
    const ref = decodeProviderId(previous);
    if (Option.isSome(ref) && (yield* openFolderOf(s, ref.value, true))) {
      const current = yield* call(s, (client) =>
        client.fetchOne(String(ref.value.uid), { flags: true }, { uid: true }),
      );
      if (current) preservedFlags = preservedDraftFlags(current.flags);
    }
  }
  const list = yield* call(s, (c) => c.list());
  const drafts = yield* ensureFolder(s, list, "\\Drafts", "Drafts");
  const messageId = parseHeaders(raw).get("message-id");
  let uid: number | undefined;
  let uidValidity: bigint | undefined;
  const recoveredIds = new Set<string>();
  const originalUids = new Set<number>();
  if (context?.appendedDraftMessageId) {
    const mailbox = yield* call(s, (c) => c.mailboxOpen(drafts, { readOnly: true }));
    const found = yield* searchUids(s, {
      header: { "message-id": context.appendedDraftMessageId },
      deleted: false,
    });
    for (const recoveredUid of found) {
      originalUids.add(recoveredUid);
      recoveredIds.add(encodeProviderId(drafts, mailbox.uidValidity, recoveredUid));
    }
    if (found.length) {
      const recoveredUid = Math.max(...found);
      const current = yield* call(s, (c) =>
        c.fetchOne(String(recoveredUid), { uid: true, source: true, flags: true }, { uid: true }),
      );
      if (!current || !current.source)
        return yield* new ProviderError({ message: "Cannot verify the recovered draft content." });
      if (organization === undefined) preservedFlags = preservedDraftFlags(current.flags);
      const currentSource = current.source;
      const unchanged = yield* Effect.tryPromise({
        try: () => sameDraftContent(codec, currentSource, raw),
        catch: (error) =>
          new ProviderError({
            message: `Cannot compare recovered draft content: ${describe(error)}`,
          }),
      });
      const flags = new Set(preservedDraftFlags(current.flags));
      const requestedFlags = new Set([
        ...(organization?.starred ? ["\\Flagged"] : []),
        ...(organization?.labels ?? []),
      ]);
      const organizationUnchanged =
        organization === undefined ||
        (flags.size === requestedFlags.size &&
          [...flags].every((flag) => requestedFlags.has(flag)));
      if (unchanged && organizationUnchanged) {
        uid = recoveredUid;
        uidValidity = mailbox.uidValidity;
      }
    }
  }
  if (uid === undefined) {
    if (context?.beforeAppendDraft && messageId) yield* context.beforeAppendDraft(messageId);
    const appended = yield* call(s, (c) =>
      c.append(drafts, raw, [
        "\\Draft",
        "\\Seen",
        ...(organization?.starred ? ["\\Flagged"] : []),
        ...(organization?.labels ?? []),
        ...preservedFlags,
      ]),
    );
    if (!appended) return yield* new ProviderError({ message: "Appending the draft failed" });
    uid = appended.uid;
    uidValidity = appended.uidValidity;
    if (uid === undefined || uidValidity === undefined) {
      const mailbox = yield* call(s, (c) => c.mailboxOpen(drafts, { readOnly: true }));
      uidValidity = mailbox.uidValidity;
      const found = messageId
        ? yield* searchUids(s, { header: { "message-id": messageId }, deleted: false })
        : [];
      const created = found.filter((foundUid) => !originalUids.has(foundUid));
      uid = created.length ? Math.max(...created) : undefined;
    }
  }
  if (uid === undefined || uidValidity === undefined)
    return yield* new ProviderError({
      message: "The new draft UID is unknown; the previous draft was kept.",
    });
  const id = encodeProviderId(drafts, uidValidity, uid);
  if (previous) recoveredIds.add(previous);
  const cleaned = new Set<string>();
  const failed: string[] = [];
  for (const candidate of recoveredIds) {
    const canonical = Option.getOrElse(canonicalImapId(candidate), () => candidate);
    if (sameImapId(candidate, id) || cleaned.has(canonical)) continue;
    cleaned.add(canonical);
    const deleted = yield* deleteMessage(s, candidate).pipe(Effect.result);
    if (deleted._tag === "Failure") failed.push(candidate);
  }
  return {
    draftId: id,
    messageId: id,
    ...(failed.length === 1 ? { cleanupMessageId: failed[0] } : {}),
    ...(failed.length > 1 ? { cleanupMessageIds: failed } : {}),
  } satisfies DraftRemote;
});

export const makeImapSend = ({
  session,
  smtp,
  codec,
}: {
  session: ImapPool["session"];
  smtp: typeof smtpTransport;
  codec: MailCodec["Service"];
}) => {
  const observedSent = new Set<string>();

  const send: ProviderAdapter["send"] = (account, message: OutgoingMessage, original) =>
    Effect.gen(function* () {
      const recipients = [
        ...new Set([...message.to, ...message.cc, ...message.bcc].map((a) => a.address)),
      ];
      if (!recipients.length) yield* new PermanentError({ message: "No recipients" });
      const { s, settings, pass } = yield* session(account);
      const threading = Option.isSome(original)
        ? yield* threadingOf(s, original.value.providerId)
        : {};
      const raw = yield* buildMime({ name: "", address: account.email }, message, threading).pipe(
        Effect.mapError(
          (error) => new ProviderError({ message: `Cannot build the message: ${describe(error)}` }),
        ),
      );

      const phase = { dataSent: false };
      const transport = yield* smtp(account.id, settings, pass, () => {
        phase.dataSent = true;
      });
      const smtpRaw = stripBcc(raw);
      const submission = yield* Effect.tryPromise({
        try: () =>
          transport.sendMail({
            envelope: { from: account.email, to: recipients, size: smtpRaw.length },
            raw: smtpRaw,
          }),
        catch: (error) => error,
      }).pipe(Effect.result);
      let confirmed = false;
      const rejected: string[] = [];
      if (submission._tag === "Failure") {
        const error = submission.failure;
        const responseCode =
          Predicate.isObject(error) &&
          "responseCode" in error &&
          typeof error.responseCode === "number"
            ? error.responseCode
            : undefined;
        const code = Predicate.isObject(error) && "code" in error ? error.code : undefined;
        const command = Predicate.isObject(error) && "command" in error ? error.command : undefined;
        if (isAuthFailure(error)) return yield* failure(account.id, settings.smtpHost, error);
        if (responseCode !== undefined && responseCode >= 500)
          return yield* new PermanentError({
            message: `${settings.smtpHost}: ${describe(error)}`,
          });
        if (
          code === "EMESSAGE" &&
          command === "MAIL FROM" &&
          /size larger than allowed/i.test(describe(error))
        )
          return yield* new PermanentError({
            message: `SMTP SIZE limit: ${describe(error)}. Remove attachments before sending.`,
          });
        // CONN errors occur during greeting, authentication and DATA; only the tracked DATA phase is uncertain.
        const uncertain =
          phase.dataSent &&
          responseCode === undefined &&
          (code === "ETIMEDOUT" ||
            code === "ESOCKET" ||
            code === "ECONNECTION" ||
            code === "ECONNRESET" ||
            code === "EPIPE" ||
            command === "DATA");
        if (!uncertain) return yield* failure(account.id, settings.smtpHost, error);
        const messageId = parseHeaders(raw).get("message-id");
        yield* confirmDelivery(
          Effect.gen(function* () {
            if (!messageId) return false;
            const fresh = yield* session(account);
            const folders = yield* call(fresh.s, (c) => c.list());
            const sent =
              folders.find((folder) => folder.specialUse === "\\Sent")?.path ??
              folders.find((folder) => folder.path === "Sent")?.path;
            if (!sent) return false;
            yield* call(fresh.s, (c) => c.mailboxOpen(sent, { readOnly: true }));
            return (
              (yield* searchUids(fresh.s, {
                header: { "message-id": messageId },
                deleted: false,
              })).length > 0
            );
          }).pipe(Effect.scoped),
        );
        confirmed = true;
        observedSent.add(account.id);
      } else {
        for (const address of submission.success.rejected) rejected.push(address);
      }

      let sentCopyMissing = false;
      if (!confirmed) {
        const serverSaves = serverSavesSent(settings) || observedSent.has(account.id);
        const saved = yield* saveSent(s, raw, serverSaves, observedSent).pipe(Effect.result);
        if (saved._tag === "Failure") {
          const retried = yield* Effect.gen(function* () {
            const fresh = yield* session(account);
            yield* saveSent(fresh.s, raw, serverSaves, observedSent);
          }).pipe(Effect.scoped, Effect.result);
          sentCopyMissing = retried._tag === "Failure";
        }
      }
      return rejected.length || sentCopyMissing
        ? {
            ...(rejected.length ? { rejected } : {}),
            ...(sentCopyMissing ? { sentCopyMissing: true } : {}),
          }
        : undefined;
    }).pipe(Effect.scoped);

  const saveDraft: ProviderAdapter["saveDraft"] = (
    account,
    draft: DraftPush,
    context?: ProviderPushContext,
  ) =>
    Effect.gen(function* () {
      const { s } = yield* session(account);
      const threading = Option.isSome(draft.original)
        ? yield* threadingOf(s, draft.original.value.providerId)
        : {};
      const raw = yield* buildMime({ name: "", address: account.email }, draft.message, threading, {
        draft: true,
        ...(context?.appendedDraftMessageId ? { messageId: context.appendedDraftMessageId } : {}),
      }).pipe(
        Effect.mapError(
          (error) => new ProviderError({ message: `Cannot build the draft: ${describe(error)}` }),
        ),
      );
      return yield* appendDraft(
        s,
        raw,
        draft.remote?.messageId ?? null,
        draft.message.draftOrganization,
        context,
        codec,
      );
    }).pipe(Effect.scoped);

  const deleteDraft: ProviderAdapter["deleteDraft"] = (account, remote) =>
    Effect.gen(function* () {
      const id = remote.messageId ?? remote.draftId;
      if (!id && !remote.rfcMessageId) return;
      const { s } = yield* session(account);
      if (id) yield* deleteMessage(s, id);
      if (remote.rfcMessageId) {
        const list = yield* call(s, (c) => c.list());
        const drafts = list.filter(
          (folder) =>
            !folder.flags.has("\\Noselect") &&
            (folder.specialUse === "\\Drafts" ||
              folder.path
                .split(folder.delimiter || "/")
                .at(-1)
                ?.toLowerCase() === "drafts"),
        );
        for (const folder of drafts) {
          const mailbox = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
          const found = yield* searchUids(s, { header: { "message-id": remote.rfcMessageId } });
          for (const uid of found) {
            const matched = encodeProviderId(folder.path, mailbox.uidValidity, uid);
            if (!id || !sameImapId(id, matched)) yield* deleteMessage(s, matched);
          }
        }
      }
    }).pipe(Effect.scoped);
  return {
    send,
    saveDraft,
    getDraftOrganization: (account, id) =>
      Effect.gen(function* () {
        const ref = decodeProviderId(id);
        if (Option.isNone(ref))
          return yield* new PermanentError({ message: `Not an IMAP message id: ${id}` });
        const { s } = yield* session(account);
        const same = yield* openFolderOf(s, ref.value, true);
        const message = same
          ? yield* call(s, (client) =>
              client.fetchOne(String(ref.value.uid), { flags: true }, { uid: true }),
            )
          : false;
        if (!message) return yield* new PermanentError({ message: `Message ${id} is gone` });
        return {
          labels: [...(message.flags ?? [])].filter((flag) => !flag.startsWith("\\")),
          starred: message.flags?.has("\\Flagged") ?? false,
        };
      }).pipe(Effect.scoped),
    deleteDraft,
  } satisfies Pick<ProviderAdapter, "send" | "saveDraft" | "getDraftOrganization" | "deleteDraft">;
};
