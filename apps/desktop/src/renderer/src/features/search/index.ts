// Public surface for other features: always-loaded modules only (see tests/layers.test.ts).
export { SearchField } from "./SearchField";
export { SearchHitBar } from "./SearchHitBar";
export {
  markPlainSearchHits,
  NO_SEARCH_HITS,
  type SearchHits,
  SearchHitsContext,
  searchTermsOf,
  useSearchHits,
} from "./search-hits";
export {
  attachmentMatches,
  distinctAttachmentMatches,
  MatchedText,
  SearchPreview,
  SearchSnippet,
} from "./SearchSnippet";
