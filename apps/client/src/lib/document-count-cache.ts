import type { DocumentCountRequest, DocumentCountResult } from "@orbit/contracts";

export const DOCUMENT_COUNT_CACHE_TTL_MS = 60_000;
export type DocumentCountCacheEntry = { result: DocumentCountResult; cachedAt: number };

export function documentCountCacheKey(request: DocumentCountRequest): string {
  return JSON.stringify([request.connectionId, request.namespace, request.object, request.filters ?? []]);
}

export function freshDocumentCount(cache: Map<string, DocumentCountCacheEntry>, key: string, now = Date.now()): DocumentCountResult | undefined {
  const entry = cache.get(key);
  if (!entry || now - entry.cachedAt >= DOCUMENT_COUNT_CACHE_TTL_MS) return undefined;
  return entry.result;
}
