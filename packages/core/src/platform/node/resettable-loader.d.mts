export function resettableLoader<T>(factory: () => Promise<T>): () => Promise<T>;
