import type { DataObject } from "@orbit/contracts";
import type { DatabaseTransportMode } from "./runtime";

export const OBJECT_GROUP_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface ObjectSchemaCache {
  namespaces?: string[];
  objects: DataObject[];
  refreshedAt: string;
}

export function objectSchemaCacheKey(mode: DatabaseTransportMode, connectionId: string): string {
  return `orbit.object-schema.v1:${mode}:${encodeURIComponent(connectionId)}`;
}

export function objectGroupCacheKey(mode: DatabaseTransportMode, connectionId: string, namespace: string): string {
  return `orbit.object-group.v2:${mode}:${encodeURIComponent(connectionId)}:${encodeURIComponent(namespace)}`;
}

export function expandedObjectGroupsKey(mode: DatabaseTransportMode, connectionId: string): string {
  return `orbit.expanded-object-groups.v1:${mode}:${encodeURIComponent(connectionId)}`;
}

export function serializeObjectGroup(objects: DataObject[], cachedAt = Date.now()): string {
  return JSON.stringify({ objects, cachedAt });
}

function normalizedObjects(objects: unknown[]): DataObject[] {
  return (objects as Array<Omit<DataObject, "estimatedRows"> & { estimatedRows?: number | null }>).map((object): DataObject => {
    const { estimatedRows, ...rest } = object;
    return typeof estimatedRows === "number" ? { ...rest, estimatedRows } : rest;
  });
}

export function parseObjectGroup(raw: string | null, now = Date.now()): DataObject[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("cachedAt" in parsed) || !("objects" in parsed)) return undefined;
    const cachedAt = Number(parsed.cachedAt);
    if (!Number.isFinite(cachedAt) || now - cachedAt >= OBJECT_GROUP_CACHE_TTL_MS || !Array.isArray(parsed.objects)) return undefined;
    return normalizedObjects(parsed.objects);
  } catch {
    return undefined;
  }
}

export function serializeObjectSchema(value: ObjectSchemaCache, cachedAt = Date.now()): string {
  return JSON.stringify({ ...value, cachedAt });
}

export function parseObjectSchema(raw: string | null, now = Date.now()): ObjectSchemaCache | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("cachedAt" in parsed) || !("objects" in parsed) || !("refreshedAt" in parsed)) return undefined;
    const cachedAt = Number(parsed.cachedAt);
    const namespaces = "namespaces" in parsed ? parsed.namespaces : undefined;
    if (!Number.isFinite(cachedAt) || now - cachedAt >= OBJECT_GROUP_CACHE_TTL_MS || (namespaces !== undefined && (!Array.isArray(namespaces) || !namespaces.every((value) => typeof value === "string"))) || !Array.isArray(parsed.objects) || typeof parsed.refreshedAt !== "string") return undefined;
    return { ...(Array.isArray(namespaces) ? { namespaces } : {}), objects: normalizedObjects(parsed.objects), refreshedAt: parsed.refreshedAt };
  } catch {
    return undefined;
  }
}

export function parseExpandedObjectGroups(raw: string | null): string[] {
  if (!raw) return [];
  try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []; }
  catch { return []; }
}
