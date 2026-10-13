import { Effect, Option } from "effect";
import { attachmentRef, MAX_INLINE_BYTES, MEDIA_RAW_TOO_LARGE } from "../mime/attachments.js";
import { type Message } from "../domain/domain.js";
import { InvalidInput, NotFound } from "../domain/errors.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { cacheIO } from "./mailbox-shared.js";
import { type Mailbox } from "./mailbox.js";
import { type DerivedChunk, MediaError } from "../ai/media.js";
import { modelContext } from "../ai/model-view.js";
import { Buffer } from "../platform/bytes.js";
import { makeReaderAttachments } from "../mime/reader-attachments.js";
import { gmailThreadUrl, officialMessageUrl, validMessageProviderId } from "../reader/reading.js";
import { parseSearchQuery, quoteSearchValue, semanticRankFusion } from "../search/search.js";
import { parseStableReference, privateMailLink } from "../app/system.js";

const DEFAULT_MODEL_CHARS = 12_000;

export const makeReadingMailbox = (
  deps: MailboxDependencies & {},
  runtime: MailboxRuntimeState,
) => {
  const {
    options,
    store,
    providers,
    diskAttachments,
    emit,
    inlineImagesFromRaw,
    inlineMediaFromRaw,
    codec,
    mutate,
  } = deps;

  // Reading from the provider

  const source = Effect.fnUntraced(function* (id: string) {
    const ref = yield* store.messageRef(id);
    const account = yield* store.getAccount(ref.accountId);
    return { account, adapter: providers.get(account.provider), providerId: ref.providerId };
  });

  const rawMessageBytes = Effect.fn("Mailbox.rawMessageBytes")(function* (id: string) {
    const { account, adapter, providerId } = yield* source(id);
    return yield* adapter.fetchRaw(account, providerId);
  });

  const rawMessage = Effect.fn("Mailbox.rawMessage")(function* (id: string) {
    const raw = yield* rawMessageBytes(id);
    // Headers are ASCII; 8-bit bodies in other charsets show replacement characters.
    return new TextDecoder("utf-8").decode(raw);
  });

  const messageWebUrl = Effect.fn("Mailbox.messageWebUrl")(function* (id: string) {
    const cachedMessage = yield* store.getMessage(id).pipe(Effect.option);
    const linkedAccount = Option.isSome(cachedMessage)
      ? yield* store.getAccount(cachedMessage.value.accountId)
      : (yield* store.listAccounts)
          .filter((a) => id.startsWith(`${a.id}/`))
          .toSorted((a, b) => b.id.length - a.id.length)[0];
    if (!linkedAccount) return yield* new NotFound({ what: "account", id });
    const account = linkedAccount;
    if (account.enabled === false)
      return yield* new InvalidInput({
        message: "Enable this account to open mail on the web",
      });
    const adapter = providers.get(account.provider);
    const providerId = id.slice(account.id.length + 1);
    if (!providerId) return yield* new InvalidInput({ message: "Invalid message link" });
    if (account.provider === "imap")
      return yield* new InvalidInput({
        message: "This account has no supported web mail link.",
      });
    if (
      (account.provider !== "gmail" || Option.isNone(cachedMessage)) &&
      !validMessageProviderId(account.provider, providerId)
    )
      return yield* new InvalidInput({ message: "Invalid message link" });
    const message = Option.getOrNull(cachedMessage);
    if (account.provider === "gmail")
      return gmailThreadUrl(account.email, message?.threadId ?? providerId);
    const cached = message?.webLink && officialMessageUrl("outlook", message.webLink);
    if (cached) return cached;
    const fetched = yield* adapter.fetchMessage(account, providerId);
    const url = fetched.webLink && officialMessageUrl("outlook", fetched.webLink);
    if (!url)
      return yield* new InvalidInput({
        message: "The provider did not return an official Outlook web link.",
      });
    if (message) yield* store.setMessageWebLink(id, url);
    return url;
  });

  const attachment = Effect.fn("Mailbox.attachment")(function* (messageId: string, index: number) {
    const message = yield* store.getMessage(messageId);
    const listed = message.attachments[index];
    const ref = attachmentRef(message.attachments, index);
    if (!listed || !ref) {
      return yield* new NotFound({ what: "attachment", id: `${messageId}#${index}` });
    }
    const { account, adapter, providerId } = yield* source(messageId);
    const key = JSON.stringify([providerId, index, listed.filename, listed.mimeType, listed.size]);
    const epoch = runtime.attachmentEpoch;
    const diskVersion = diskAttachments?.version();
    const maxBytes = (yield* store.prefs).attachmentCacheBytes;
    const cached =
      (diskAttachments
        ? yield* cacheIO(
            () => diskAttachments.get(account.id, JSON.stringify([messageId, key]), maxBytes),
            null,
          )
        : null) ?? runtime.attachmentCache.get(messageId, key);
    if (cached) return { filename: listed.filename, mimeType: listed.mimeType, data: cached };
    const data = yield* adapter.fetchAttachment(account, providerId, ref);
    yield* store.getAccount(account.id);
    if (epoch === runtime.attachmentEpoch) {
      runtime.attachmentCache.set(messageId, key, data);
      if (diskAttachments)
        yield* cacheIO(
          () =>
            diskAttachments.set(
              account.id,
              JSON.stringify([messageId, key]),
              data,
              maxBytes,
              diskVersion,
            ),
          undefined,
        );
      yield* emit({ _tag: "BackfillProgress" });
    }
    return { filename: listed.filename, mimeType: listed.mimeType, data };
  });

  // The reader asks on every open; reuse the session cache instead of downloading again.
  const inlineImages = Effect.fn("Mailbox.inlineImages")(function* (messageId: string) {
    const cached = runtime.attachmentCache.get(messageId, "inline-raw");
    if (cached) return yield* inlineImagesFromRaw(cached);
    const { account, adapter, providerId } = yield* source(messageId);
    const epoch = runtime.attachmentEpoch;
    const raw = yield* adapter.fetchRaw(account, providerId);
    if (epoch === runtime.attachmentEpoch)
      runtime.attachmentCache.set(messageId, "inline-raw", raw);
    return yield* inlineImagesFromRaw(raw);
  });

  const localInline = Effect.fnUntraced(function* (id: string) {
    const message = yield* store.getMessage(id);
    if (
      Buffer.byteLength(message.bodyHtml) +
        message.attachments.reduce((total, part) => total + part.size, 0) >
      MAX_INLINE_BYTES
    )
      return [];
    const { account, adapter, providerId } = yield* source(id);
    return yield* adapter.fetchRaw(account, providerId, MAX_INLINE_BYTES).pipe(
      Effect.flatMap((raw) =>
        inlineMediaFromRaw(raw).pipe(
          Effect.mapError(() => new MediaError({ message: "Cannot parse inline media" })),
        ),
      ),
      Effect.catchIf(
        (error) => error._tag === "PermanentError" && error.message === MEDIA_RAW_TOO_LARGE,
        () => Effect.succeed([]),
      ),
    );
  });

  const semanticThreads = Effect.fn("Mailbox.semanticThreads")(function* (
    q: import("../domain/domain.js").ThreadQuery,
  ) {
    const local = yield* store.listThreads(q);
    const parsed = parseSearchQuery(q);
    const query = parsed.search?.trim();
    if (
      !query ||
      !options.models ||
      !store.semantics.vectors ||
      !(yield* store.semantics.enabled) ||
      (yield* options.models.status).kind !== "ready"
    )
      return local;
    const models = options.models;
    const routes = yield* Effect.gen(function* () {
      // CLI/MCP may use already-present files after the app's persisted
      // opt-in. A search never starts a model download.
      yield* models.ensure(false);
      const text = yield* models.embedder.text(query, "query");
      const image = yield* models.images.query(query);
      return [
        yield* store.vectorThreads(
          q,
          yield* store.semantics.neighbors("text", text, models.version, parsed),
        ),
        yield* store.vectorThreads(
          q,
          yield* store.semantics.neighbors("image", image, models.version, parsed),
        ),
      ];
    }).pipe(Effect.catch(() => Effect.succeed([])));
    return semanticRankFusion(local, routes[0] ?? [], routes[1] ?? [], q.flat).slice(
      0,
      q.limit ?? 50,
    );
  });

  const mediaImage = Effect.fnUntraced(function* (chunk: DerivedChunk) {
    if (
      chunk.source.kind === "body" ||
      chunk.region === null ||
      !chunk.source.mimeType.toLowerCase().startsWith("image/")
    )
      return yield* new NotFound({ what: "attachment", id: chunk.messageId });
    if (chunk.source.kind === "attachment") {
      const part = yield* attachment(chunk.messageId, chunk.source.index);
      return `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`;
    }
    const images = yield* inlineImages(chunk.messageId);
    const data = images[chunk.source.cid];
    if (data === undefined)
      return yield* new NotFound({ what: "attachment", id: chunk.source.cid });
    return data;
  });

  function thread(id: string): Effect.Effect<Message[], NotFound>;

  function thread(
    id: string,
    view: "model",
    tokenBudget?: number,
  ): Effect.Effect<import("../ai/model-thread.js").ModelThread, NotFound>;

  function thread(id: string, view?: "model", tokenBudget = 6000) {
    return view === "model"
      ? Effect.map(store.getThread(id), (messages) => modelContext(messages, tokenBudget))
      : store.getThread(id);
  }
  return {
    localInline,
    service: {
      threads: semanticThreads,

      semanticSearch: (q) =>
        Effect.gen(function* () {
          if (!q.accountIds?.length || !q.search?.trim()) return [];
          const consent = yield* store.ai.accounts;
          if (q.accountIds.some((id) => !consent.some((a) => a.accountId === id && a.allowed)))
            return yield* new InvalidInput({
              message: "This account is outside the selected accounts.",
            });
          const models = options.models;
          if (
            !models ||
            !store.semantics.vectors ||
            !(yield* store.semantics.enabled) ||
            (yield* models.status).kind !== "ready"
          )
            return [];
          yield* models.ensure(false);
          const embedding = yield* models.embedder.text(q.search, "query");
          const hits = yield* store.semantics.neighbors(
            "text",
            embedding,
            models.version,
            parseSearchQuery(q),
          );
          return (yield* store.vectorThreads(q, hits)).slice(0, Math.min(q.limit ?? 5, 5));
        }).pipe(
          Effect.mapError(() => new InvalidInput({ message: "Semantic search is unavailable." })),
        ),

      threadCount: (query) => store.countThreads(query),

      privateMailLink: (id, kind) =>
        store.getMessage(id).pipe(Effect.map((message) => privateMailLink(message, kind))),

      resolveMailLink: (id) =>
        Effect.gen(function* () {
          const reference = parseStableReference(id);
          if (!reference) {
            const message = yield* store.getMessage(id);
            if ((yield* store.getAccount(message.accountId)).enabled === false)
              return yield* new NotFound({ what: "message", id });
            return id;
          }
          const account = yield* store.getAccount(reference.accountId);
          if (account.enabled === false) return yield* new NotFound({ what: "message", id });
          const cached = yield* store.findMessageByRfcId(reference.accountId, reference.messageId);
          if (cached) return cached;

          const found = yield* providers.get(account.provider).search(account, {
            mailbox: "all",
            search: `rfc822msgid:${quoteSearchValue(reference.messageId)}`,
            limit: 20,
          });
          const message = found.messages.find(
            (m) => m.rfcMessageId?.replace(/^<|>$/g, "") === reference.messageId,
          );
          if (!message) return yield* new NotFound({ what: "message", id });
          yield* store.upsertMessage(account.id, message);
          return (
            (yield* store.messageIdForProvider(account.id, message.providerId)) ??
            `${account.id}/${message.providerId}`
          );
        }),

      thread,

      threadForModel: (id, maxChars = DEFAULT_MODEL_CHARS) =>
        Effect.map(store.getThread(id), (messages) => modelContext(messages, maxChars)),

      rawMessage,

      rawMessageBytes,

      messageWebUrl,

      knownSenders: (accountId, addresses) => store.knownSenders(accountId, addresses),

      attachment,

      ...makeReaderAttachments(attachment, (id) => store.getThread(id), codec),

      inlineImages,

      imageSenders: store.imageSenders,

      setImageSender: (entry, allowed) => mutate(store.setImageSender(entry, allowed)),

      labels: (accountIds) => store.listLabels(accountIds),

      unreadCounts: store.unreadCounts,

      unreadByLabel: (accountIds, within, conversations) =>
        store.unreadByLabel(accountIds, within, conversations),

      mediaImage,
    } satisfies Pick<
      Mailbox["Service"],
      | "threads"
      | "semanticSearch"
      | "threadCount"
      | "privateMailLink"
      | "resolveMailLink"
      | "thread"
      | "threadForModel"
      | "rawMessage"
      | "rawMessageBytes"
      | "messageWebUrl"
      | "knownSenders"
      | "attachment"
      | "inlineImages"
      | "imageSenders"
      | "setImageSender"
      | "labels"
      | "unreadCounts"
      | "unreadByLabel"
      | "mediaImage"
    >,
  };
};
