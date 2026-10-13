/** Unit-vector L2 cutoffs, calibrated on spikes/media/artifacts/embeddings-hybrid.json.
 * E5: cosine >= .78875 (8/8 known positives); MobileCLIP: >= .24355
 * (3 confident English positives, weak Chinese image scores fall back to text/FTS).
 * Short Chinese language bias still cannot be corrected by a cutoff alone.
 */
export const SEMANTIC_MAX_DISTANCE = { text: 0.65, image: 1.23 } as const;
