// Public surface for other features: always-loaded modules only (see tests/layers.test.ts).
export { SearchField } from "./SearchField";
export { SearchHitBar } from "./SearchHitBar";
export { NO_SEARCH_HITS, type SearchHits, SearchHitsContext, useSearchHits } from "./search-hits";
export {
  HIGHLIGHT_CSS,
  HIGHLIGHTS,
  paintRanges,
  rangeVisible,
  scrollRangeIntoView,
  textNodes,
} from "./text-highlights";
export {
  attachmentMatches,
  distinctAttachmentMatches,
  MatchedText,
  SearchPreview,
  SearchSnippet,
} from "./SearchSnippet";
