import type { DataColumn, DataObject, DatabaseConnection, ExploreRequest, ExploreResult, ReferenceLookupRequest, ReferenceLookupResult } from "@orbit/contracts";
import type { DatabaseAdapter, QueryOptions } from "./index.js";
import { assertReadOnlyQuery, decodeCursor, encodeCursor } from "./index.js";

const records: Array<Record<string, unknown>> = [
  { id: "usr_8f2a19", email: "maya@northstar.de", name: "Maya Fischer", plan: "pro", status: "active", company: "Northstar GmbH" },
  { id: "usr_1c94d0", email: "leo@acme.studio", name: "Leo Martin", plan: "starter", status: "active", company: "Acme Studio" },
  { id: "usr_a72b41", email: "anika@orbitlabs.io", name: "Anika Rao", plan: "business", status: "active", company: "Orbit Labs" },
  { id: "usr_903ee2", email: "james@harbor.co", name: "James Wu", plan: "pro", status: "past_due", company: "Harbor Co" },
  { id: "usr_54be17", email: "sara@fieldnote.ai", name: "Sara Khan", plan: "starter", status: "trialing", company: "Fieldnote AI" },
];
const columns: DataColumn[] = [
  { name: "id", nativeType: "uuid", nullable: false, primaryKey: true },
  { name: "email", nativeType: "text", nullable: false }, { name: "name", nativeType: "text", nullable: false },
  { name: "plan", nativeType: "text", nullable: false }, { name: "status", nativeType: "text", nullable: false },
  { name: "company", nativeType: "text", nullable: true },
];

export function createDemoAdapter(connection: DatabaseConnection): DatabaseAdapter {
  return {
    kind: connection.kind,
    async testConnection() { return { latencyMs: 1 }; },
    async listObjects(connectionId: string) { return [
      { connectionId, namespace: "public", name: "users", kind: "table", estimatedRows: records.length },
      { connectionId, namespace: "public", name: "subscriptions", kind: "table", estimatedRows: 3 },
    ]; },
    async describeObject() { return columns; },
    async explore(request: ExploreRequest, _options: QueryOptions): Promise<ExploreResult> {
      const started = performance.now(); const offset = decodeCursor(request.cursor);
      let selected = records.filter((row) => request.filters?.every((filter) => {
        const actual = row[filter.column]; const expected = filter.value;
        if (filter.operator === "eq") return actual === expected;
        if (filter.operator === "neq") return actual !== expected;
        if (filter.operator === "contains") return String(actual ?? "").toLowerCase().includes(String(expected).toLowerCase());
        if (filter.operator === "gt") return String(actual) > String(expected);
        return String(actual) < String(expected);
      }) ?? true);
      if (request.search) { const needle = request.search.toLowerCase(); selected = selected.filter((row) => Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(needle))); }
      const sort = request.sort?.[0];
      if (sort) selected = [...selected].sort((left, right) => String(left[sort.column] ?? "").localeCompare(String(right[sort.column] ?? "")) * (sort.direction === "asc" ? 1 : -1));
      const rows = selected.slice(offset, offset + request.limit); const hasMore = offset + rows.length < selected.length;
      return { columns, rows, totalRows: selected.length, ...(hasMore ? { nextCursor: encodeCursor(offset + rows.length) } : {}), durationMs: Math.round(performance.now() - started), truncated: hasMore };
    },
    async resolveReference(request: ReferenceLookupRequest): Promise<ReferenceLookupResult> {
      const reference = request.reference;
      if (!reference) return { matches: [], inferredCollections: [], searchedCollections: 0, searchAllAvailable: false, strategy: "none" };
      const matches = reference.namespace === "public" && reference.object === "users" && reference.column === "id"
        ? records.filter((row) => row.id === request.value).slice(0, 2).map((document) => ({ database: "public", collection: "users", document, columns }))
        : [];
      return { matches, inferredCollections: [`${reference.namespace}.${reference.object}`], searchedCollections: 1, searchAllAvailable: false, strategy: "foreign_key" };
    },
    async executeReadOnly(query, limit) { assertReadOnlyQuery(query); const rows = records.slice(0, limit); return { columns, rows, durationMs: 1, truncated: records.length > limit }; },
    async close() {},
  };
}
