import { describe, expect, it } from "vitest";
import { DOCUMENT_COUNT_CACHE_TTL_MS, documentCountCacheKey, freshDocumentCount } from "./document-count-cache";

describe("document count cache", () => {
  const request = { connectionId: "mongo", namespace: "app", object: "users" };

  it("keys counts by collection and filter", () => {
    expect(documentCountCacheKey(request)).not.toBe(documentCountCacheKey({ ...request, filters: [{ column: "active", operator: "eq", value: true }] }));
  });

  it("returns only fresh cached counts", () => {
    const key = documentCountCacheKey(request);
    const result = { count: 42, estimated: true, durationMs: 3 };
    const cache = new Map([[key, { result, cachedAt: 1_000 }]]);
    expect(freshDocumentCount(cache, key, 1_000 + DOCUMENT_COUNT_CACHE_TTL_MS - 1)).toEqual(result);
    expect(freshDocumentCount(cache, key, 1_000 + DOCUMENT_COUNT_CACHE_TTL_MS)).toBeUndefined();
  });
});
