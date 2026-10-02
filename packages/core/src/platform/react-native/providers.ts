import { Effect, Layer, Stream } from "effect";
import { makeGmail } from "../../gmail.js";
import { makeOutlook } from "../../outlook.js";
import { ProviderError } from "../../errors.js";
import { Providers, type ProviderAdapter } from "../../services.js";

const unsupported = () =>
  Effect.fail(new ProviderError({ message: "IMAP/SMTP is unsupported on mobile" }));
export const unsupportedMobileImap: ProviderAdapter = {
  connect: unsupported,
  pull: () => Stream.fail(new ProviderError({ message: "IMAP/SMTP is unsupported on mobile" })),
  push: unsupported,
  send: unsupported,
  saveDraft: unsupported,
  deleteDraft: unsupported,
  fetchRaw: unsupported,
  fetchAttachment: unsupported,
  fetchMessage: unsupported,
  listFolderMessages: unsupported,
  markReadBatch: unsupported,
  checkPermanentDelete: unsupported,
  permanentlyDelete: unsupported,
  contacts: unsupported,
  respondInvite: unsupported,
  backfill: unsupported,
  search: unsupported,
  changeLabel: unsupported,
  filters: unsupported,
  createFilter: unsupported,
  updateFilter: unsupported,
  deleteFilter: unsupported,
  vacation: unsupported,
  setVacation: unsupported,
  sendAs: unsupported,
};
export const mobileProvidersLayer = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const gmail = yield* makeGmail;
    const outlook = yield* makeOutlook;
    const adapters = { gmail, outlook, imap: unsupportedMobileImap };
    return Providers.of({ get: (provider) => adapters[provider] });
  }),
);
