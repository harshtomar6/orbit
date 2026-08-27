import type { DataColumn, DataObject, DatabaseConnection, DocumentCountRequest, DocumentCountResult, ExploreRequest, ExploreResult, ReferenceLookupRequest, ReferenceLookupResult } from "@orbit/contracts";
import { z } from "zod";

export interface QueryOptions { signal?: AbortSignal; timeoutMs: number; maxResponseBytes: number }
export interface QueryExecutionContext { namespace?: string; object?: string }
export interface ObjectProfile { columns: DataColumn[]; sampledDocuments: number }
export interface DatabaseAdapter {
  readonly kind: DatabaseConnection["kind"];
  testConnection(options: QueryOptions): Promise<{ latencyMs: number }>;
  listNamespaces?(options: QueryOptions): Promise<string[]>;
  listObjects(connectionId: string, options: QueryOptions, namespace?: string): Promise<DataObject[]>;
  describeObject(namespace: string, name: string, options: QueryOptions): Promise<DataColumn[]>;
  profileObject?(namespace: string, name: string, options: QueryOptions): Promise<ObjectProfile>;
  explore(request: ExploreRequest, options: QueryOptions): Promise<ExploreResult>;
  countDocuments?(request: DocumentCountRequest, options: QueryOptions): Promise<DocumentCountResult>;
  resolveReference?(request: ReferenceLookupRequest, options: QueryOptions): Promise<ReferenceLookupResult>;
  executeReadOnly(query: string, limit: number, options: QueryOptions, context?: QueryExecutionContext): Promise<ExploreResult>;
  close(): Promise<void>;
}

export type AdapterFactory = (connection: DatabaseConnection, connectionUri: string) => Promise<DatabaseAdapter>;

export class AdapterRegistry {
  readonly #factories = new Map<DatabaseConnection["kind"], AdapterFactory>();
  register(kind: DatabaseConnection["kind"], factory: AdapterFactory): this { this.#factories.set(kind, factory); return this; }
  async create(connection: DatabaseConnection, connectionUri: string): Promise<DatabaseAdapter> {
    const factory = this.#factories.get(connection.kind);
    if (!factory) throw new AdapterNotConfiguredError(connection.kind);
    return factory(connection, connectionUri);
  }
}

export class AdapterNotConfiguredError extends Error {
  constructor(kind: DatabaseConnection["kind"]) { super(`The ${kind} adapter is not configured.`); this.name = "AdapterNotConfiguredError"; }
}
export class QueryRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "QueryRejectedError"; }
}

export function assertReadOnlyQuery(query: string): void {
  const normalized = query.trim().replace(/^\(+/, "").toLowerCase();
  if (!/^(select|with|show|explain)\b/.test(normalized) || /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy)\b/.test(normalized)) {
    throw new QueryRejectedError("Only a single read-only query is permitted.");
  }
  if (query.replace(/;\s*$/, "").includes(";")) throw new QueryRejectedError("Multiple statements are not permitted.");
}

const mongoPipelineSchema = z.array(z.record(z.string(), z.unknown())).min(1).max(50);
const allowedMongoStages = new Set(["$match", "$project", "$group", "$sort", "$limit", "$skip", "$unwind", "$lookup", "$count", "$addFields", "$set", "$unset", "$replaceRoot", "$replaceWith", "$facet", "$bucket", "$bucketAuto", "$sortByCount", "$sample"]);
export function parseReadOnlyMongoPipeline(query: string): Array<Record<string, unknown>> {
  let parsed: unknown; try { parsed = JSON.parse(query); } catch { throw new QueryRejectedError("The MongoDB aggregation pipeline is not valid JSON."); }
  const pipeline = mongoPipelineSchema.safeParse(parsed); if (!pipeline.success) throw new QueryRejectedError("The MongoDB query must be a non-empty aggregation pipeline.");
  for (const stage of pipeline.data) { const keys = Object.keys(stage); if (keys.length !== 1 || !allowedMongoStages.has(keys[0] ?? "")) throw new QueryRejectedError(`MongoDB stage ${keys[0] ?? "unknown"} is not permitted.`); const serialized = JSON.stringify(stage); if (/\$(out|merge|function|accumulator|where)\b/i.test(serialized)) throw new QueryRejectedError("The MongoDB pipeline contains an unsafe operator."); }
  return pipeline.data;
}

export function encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }
export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try { const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value === "object" && value !== null && "offset" in value && Number.isInteger(value.offset) && Number(value.offset) >= 0) return Number(value.offset);
  } catch { /* invalid cursor handled below */ }
  throw new QueryRejectedError("The pagination cursor is invalid.");
}

export { createMongoAdapter, createMySqlAdapter, createPostgresAdapter } from "./production-adapters.js";
export { createDemoAdapter } from "./demo-adapter.js";
