import { describe, expect, it } from "vitest";
import { OBJECT_GROUP_CACHE_TTL_MS, expandedObjectGroupsKey, objectGroupCacheKey, objectSchemaCacheKey, parseExpandedObjectGroups, parseObjectGroup, parseObjectSchema, serializeObjectGroup, serializeObjectSchema } from "./object-group-cache";

describe("object group cache", () => {
  const objects = [{ connectionId: "mongo", namespace: "app db", name: "users", kind: "collection" as const }];

  it("scopes collection data by transport, connection, and database", () => {
    expect(objectGroupCacheKey("local", "mongo", "app db")).not.toBe(objectGroupCacheKey("gateway", "mongo", "app db"));
    expect(expandedObjectGroupsKey("local", "mongo")).toContain("mongo");
    expect(objectSchemaCacheKey("local", "mongo")).not.toBe(objectSchemaCacheKey("gateway", "mongo"));
  });

  it("returns only fresh collection lists", () => {
    const raw = serializeObjectGroup(objects, 1_000);
    expect(parseObjectGroup(raw, 1_000 + OBJECT_GROUP_CACHE_TTL_MS - 1)).toEqual(objects);
    expect(parseObjectGroup(raw, 1_000 + OBJECT_GROUP_CACHE_TTL_MS)).toBeUndefined();
  });

  it("ignores invalid expanded-group state", () => {
    expect(parseExpandedObjectGroups('["app",3,"logs"]')).toEqual(["app", "logs"]);
    expect(parseExpandedObjectGroups("bad json")).toEqual([]);
  });

  it("normalizes legacy null estimates from the desktop boundary", () => {
    const parsed = parseObjectGroup(JSON.stringify({ cachedAt: 1_000, objects: [{ ...objects[0], estimatedRows: null }] }), 1_001);
    expect(parsed?.[0]).not.toHaveProperty("estimatedRows");
  });

  it("restores a fresh connection-level database and object index", () => {
    const cached = { namespaces: ["app"], objects, refreshedAt: "2026-08-23T00:00:00.000Z" };
    expect(parseObjectSchema(serializeObjectSchema(cached, 1_000), 1_001)).toEqual(cached);
    expect(parseObjectSchema(serializeObjectSchema(cached, 1_000), 1_000 + OBJECT_GROUP_CACHE_TTL_MS)).toBeUndefined();
    const postgres = { objects: [{ ...objects[0]!, kind: "table" as const }], refreshedAt: cached.refreshedAt };
    expect(parseObjectSchema(serializeObjectSchema(postgres, 1_000), 1_001)).toEqual(postgres);
  });
});
