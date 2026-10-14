import type { Effect } from "effect";
import type { Store } from "../store/service.js";
import type { MailboxCompose } from "./mailbox.js";

const DEFAULT_SUGGESTIONS = 8;

/** Signatures, templates and recipient suggestions; all local, no provider requests. */
export function makeComposeSettingsMailbox(
  store: Store["Service"],
  mutate: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
) {
  return {
    namedSignatures: store.namedSignatures,

    signatureDefaults: store.signatureDefaults,

    saveNamedSignature: (input, id) => mutate(store.saveNamedSignature(input, id)),

    deleteNamedSignature: (id) => mutate(store.deleteNamedSignature(id)),

    setSignatureDefault: (setting) => mutate(store.setSignatureDefault(setting)),

    signatures: store.signatures,

    setSignature: (signature) => mutate(store.setSignature(signature)),

    templates: store.templates,

    saveTemplate: (input, id) => mutate(store.saveTemplate(id ?? null, input)),

    deleteTemplate: (id) => mutate(store.deleteTemplate(id)),

    suggestContacts: (query, { limit = DEFAULT_SUGGESTIONS, exclude, accountIds } = {}) =>
      store.suggestContacts(query, limit, exclude, accountIds),

    contactAlternatives: (address) => store.contactAlternatives(address),

    hiddenContacts: store.hiddenContacts,

    setContactHidden: (address, hidden) => mutate(store.setContactHidden(address, hidden)),
  } satisfies Pick<
    MailboxCompose,
    | "namedSignatures"
    | "signatureDefaults"
    | "saveNamedSignature"
    | "deleteNamedSignature"
    | "setSignatureDefault"
    | "signatures"
    | "setSignature"
    | "templates"
    | "saveTemplate"
    | "deleteTemplate"
    | "suggestContacts"
    | "contactAlternatives"
    | "hiddenContacts"
    | "setContactHidden"
  >;
}
