import type { DataColumn, DataObject, DatabaseConnection, ExploreFilter, ReferenceLookupRequest, ReferenceLookupResult } from "@orbit/contracts";
import { BSON, MongoClient, ObjectId, type Document, type Filter } from "mongodb";
import mysql, { type Pool as MySqlPool, type RowDataPacket } from "mysql2/promise";
import pg from "pg";
import { assertReadOnlyQuery, decodeCursor, encodeCursor, parseReadOnlyMongoPipeline, QueryRejectedError, type DatabaseAdapter, type ObjectProfile, type QueryOptions } from "./index.js";

const { Pool: PgPool } = pg;
const identifier = (value: string, quote: '"' | "`") => `${quote}${value.replaceAll(quote, quote + quote)}${quote}`;
const withinSize = (rows: Array<Record<string, unknown>>, max: number) => Buffer.byteLength(JSON.stringify(rows)) <= max;
const timed = async <T>(promise: Promise<T>, options: QueryOptions): Promise<T> => {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return await Promise.race([promise, new Promise<T>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Query cancelled or timed out", "AbortError")), { once: true }))]);
};

const referenceScalarText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new QueryRejectedError("The linked value cannot be used in a PostgreSQL foreign-key lookup.");
};

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function sqlWhere(filters: ExploreFilter[] | undefined, start: number, dialect: "postgres" | "mysql") {
  const values: unknown[] = []; const clauses: string[] = [];
  for (const filter of filters ?? []) {
    const column = identifier(filter.column, dialect === "postgres" ? '"' : "`"); values.push(filter.value);
    const placeholder = dialect === "postgres" ? `$${start + values.length}` : "?";
    const operator = { eq: "=", neq: "<>", gt: ">", lt: "<", contains: dialect === "postgres" ? "::text ILIKE" : "LIKE" }[filter.operator];
    clauses.push(`${column} ${operator} ${placeholder}`);
    if (filter.operator === "contains") values[values.length - 1] = `%${String(filter.value)}%`;
  }
  return { clause: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

export async function createPostgresAdapter(connection: DatabaseConnection, connectionUri: string): Promise<DatabaseAdapter> {
  const pool = new PgPool({ connectionString: connectionUri, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: "orbit-gateway" });
  const describe = async (namespace: string, name: string, options: QueryOptions) => { const result = await timed(pool.query<{ name: string; native_type: string; nullable: boolean; primary_key: boolean; reference_namespace: string | null; reference_object: string | null; reference_column: string | null; enum_values: string[] | null }>(`SELECT a.attname name, pg_catalog.format_type(a.atttypid,a.atttypmod) native_type, NOT a.attnotnull nullable, EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) primary_key, fk.reference_namespace, fk.reference_object, fk.reference_column, (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=a.atttypid) enum_values FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN LATERAL (SELECT rn.nspname reference_namespace,rc.relname reference_object,ra.attname reference_column FROM pg_constraint con JOIN LATERAL generate_subscripts(con.conkey,1) pos(i) ON true JOIN pg_class rc ON rc.oid=con.confrelid JOIN pg_namespace rn ON rn.oid=rc.relnamespace JOIN pg_attribute ra ON ra.attrelid=con.confrelid AND ra.attnum=con.confkey[pos.i] WHERE con.conrelid=a.attrelid AND con.contype='f' AND con.conkey[pos.i]=a.attnum ORDER BY con.oid LIMIT 1) fk ON true WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [namespace, name]), options); return result.rows.map((row): DataColumn => ({ name: row.name, nativeType: row.native_type, nullable: row.nullable, ...(row.primary_key ? { primaryKey: true } : {}), ...(row.reference_namespace && row.reference_object && row.reference_column ? { reference: { namespace: row.reference_namespace, object: row.reference_object, column: row.reference_column } } : {}), ...(row.enum_values?.length ? { enumValues: row.enum_values } : {}) })); };
  return {
    kind: "postgres",
    async testConnection(options) { const start = performance.now(); await timed(pool.query("SELECT 1"), options); return { latencyMs: Math.round(performance.now() - start) }; },
    async listObjects(connectionId, options) {
      const result = await timed(pool.query<{ namespace: string; name: string; kind: "table" | "view"; estimated_rows: string | null }>(`SELECT n.nspname namespace, c.relname name, CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END kind, GREATEST(c.reltuples, 0)::bigint::text estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY n.nspname,c.relname`), options);
      return result.rows.map((row): DataObject => ({ connectionId, namespace: row.namespace, name: row.name, kind: row.kind, ...(row.estimated_rows === null ? {} : { estimatedRows: Number(row.estimated_rows) }) }));
    },
    describeObject: describe,
    async explore(request, options) {
      const start = performance.now(); const offset = decodeCursor(request.cursor); const where = sqlWhere(request.filters, 1, "postgres");
      const order = request.sort?.length ? ` ORDER BY ${request.sort.map((item) => `${identifier(item.column, '"')} ${item.direction.toUpperCase()}`).join(",")}` : "";
      const sql = `SELECT to_jsonb(orbit_row) AS orbit_document FROM (SELECT * FROM ${identifier(request.namespace, '"')}.${identifier(request.object, '"')}${where.clause}${order} LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}) orbit_row`;
      const result = await timed(pool.query<{ orbit_document: Record<string, unknown> }>(sql, [...where.values, request.limit + 1, offset]), options); const hasMore = result.rows.length > request.limit; const rows = result.rows.slice(0, request.limit).map((row) => row.orbit_document);
      if (!withinSize(rows, options.maxResponseBytes)) throw new Error("Response exceeded the configured size limit.");
      const columns = await describe(request.namespace, request.object, options);
      return { columns, rows, ...(hasMore ? { nextCursor: encodeCursor(offset + rows.length) } : {}), durationMs: Math.round(performance.now() - start), truncated: hasMore };
    },
    async resolveReference(request, options): Promise<ReferenceLookupResult> {
      const reference = request.reference;
      if (!reference) throw new QueryRejectedError("PostgreSQL foreign-key metadata is missing for this column.");
      const columns = await describe(reference.namespace, reference.object, options);
      const target = columns.find((column) => column.name === reference.column);
      if (!target) throw new QueryRejectedError("The referenced PostgreSQL column no longer exists.");
      const sql = `SELECT to_jsonb(orbit_row) AS orbit_document FROM (SELECT * FROM ${identifier(reference.namespace, '"')}.${identifier(reference.object, '"')} WHERE ${identifier(reference.column, '"')} = $1::${target.nativeType} LIMIT 2) orbit_row`;
      const result = await timed(pool.query<{ orbit_document: Record<string, unknown> }>(sql, [referenceScalarText(request.value)]), options);
      const matches = result.rows.map((row) => ({ database: reference.namespace, collection: reference.object, document: row.orbit_document, columns }));
      if (!withinSize(matches.map((match) => match.document), options.maxResponseBytes)) throw new Error("Response exceeded the configured size limit.");
      return { matches, inferredCollections: [`${reference.namespace}.${reference.object}`], searchedCollections: 1, searchAllAvailable: false, strategy: "foreign_key" };
    },
    async executeReadOnly(query, limit, options) { assertReadOnlyQuery(query); const start = performance.now(); const result = await timed(pool.query<Record<string, unknown>>(`SELECT * FROM (${query.replace(/;\s*$/, "")}) orbit_query LIMIT $1`, [limit + 1]), options); const rows = result.rows.slice(0, limit); return { columns: result.fields.map((field) => ({ name: field.name, nativeType: String(field.dataTypeID), nullable: true })), rows, durationMs: Math.round(performance.now() - start), truncated: result.rows.length > limit }; },
    async close() { await pool.end(); },
  };
}

export async function createMySqlAdapter(connection: DatabaseConnection, connectionUri: string): Promise<DatabaseAdapter> {
  const pool: MySqlPool = mysql.createPool({ uri: connectionUri, connectionLimit: 5, maxIdle: 5, idleTimeout: 30_000, enableKeepAlive: true });
  const db = connection.database;
  const describe = async (namespace: string, name: string, options: QueryOptions) => { const [rows] = await timed(pool.query<RowDataPacket[]>(`SELECT COLUMN_NAME name,COLUMN_TYPE nativeType,IS_NULLABLE nullable,COLUMN_KEY columnKey FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [namespace, name]), options); return rows.map((row): DataColumn => ({ name: String(row.name), nativeType: String(row.nativeType), nullable: row.nullable === "YES", ...(row.columnKey === "PRI" ? { primaryKey: true } : {}) })); };
  return {
    kind: "mysql",
    async testConnection(options) { const start = performance.now(); await timed(pool.query("SELECT 1"), options); return { latencyMs: Math.round(performance.now() - start) }; },
    async listObjects(connectionId, options) { const [rows] = await timed(pool.query<RowDataPacket[]>(`SELECT TABLE_SCHEMA namespace,TABLE_NAME name,CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END kind,TABLE_ROWS estimatedRows FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME`, [db]), options); return rows.map((row): DataObject => ({ connectionId, namespace: String(row.namespace), name: String(row.name), kind: row.kind === "view" ? "view" : "table", ...(row.estimatedRows === null ? {} : { estimatedRows: Number(row.estimatedRows) }) })); },
    describeObject: describe,
    async explore(request, options) { const start = performance.now(); const offset = decodeCursor(request.cursor); const where = sqlWhere(request.filters, 1, "mysql"); const order = request.sort?.length ? ` ORDER BY ${request.sort.map((item) => `${identifier(item.column, "`")} ${item.direction.toUpperCase()}`).join(",")}` : ""; const [raw] = await timed(pool.query<RowDataPacket[]>(`SELECT * FROM ${identifier(request.namespace, "`")}.${identifier(request.object, "`")}${where.clause}${order} LIMIT ? OFFSET ?`, [...where.values, request.limit + 1, offset]), options); const hasMore = raw.length > request.limit; const rows = raw.slice(0, request.limit).map((row) => ({ ...row })); if (!withinSize(rows, options.maxResponseBytes)) throw new Error("Response exceeded the configured size limit."); return { columns: await describe(request.namespace, request.object, options), rows, ...(hasMore ? { nextCursor: encodeCursor(offset + rows.length) } : {}), durationMs: Math.round(performance.now() - start), truncated: hasMore }; },
    async executeReadOnly(query, limit, options) { assertReadOnlyQuery(query); const start = performance.now(); const [raw, fields] = await timed(pool.query<RowDataPacket[]>(`SELECT * FROM (${query.replace(/;\s*$/, "")}) orbit_query LIMIT ?`, [limit + 1]), options); return { columns: fields.map((field) => ({ name: field.name, nativeType: String(field.type), nullable: true })), rows: raw.slice(0, limit).map((row) => ({ ...row })), durationMs: Math.round(performance.now() - start), truncated: raw.length > limit }; },
    async close() { await pool.end(); },
  };
}

function mongoFilter(filters: ExploreFilter[] | undefined): Filter<Document> { const result: Filter<Document> = {}; for (const item of filters ?? []) { if (item.operator === "contains") { result[item.column] = { $regex: String(item.value), $options: "i" }; continue; } const operator = { eq: "$eq", neq: "$ne", gt: "$gt", lt: "$lt" }[item.operator]; const value = item.value !== null && typeof item.value === "object" && !Array.isArray(item.value) ? BSON.EJSON.deserialize({ value: item.value }).value : item.value; result[item.column] = { [operator]: value }; } return result; }

export function mongoExtendedJson(document: Document): Record<string, unknown> {
  const serialized: unknown = BSON.EJSON.serialize(document, { relaxed: true });
  return serialized !== null && typeof serialized === "object" && !Array.isArray(serialized) ? serialized as Record<string, unknown> : {};
}

export function mongoNativeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (typeof value !== "object") return typeof value;
  const bsonType = "_bsontype" in value ? String(value._bsontype).toLowerCase() : "";
  return ({ objectid: "objectId", int32: "int32", long: "int64", double: "double", decimal128: "decimal128", binary: "binary", timestamp: "timestamp", bsonregexp: "regex", code: "javascript", symbol: "symbol" } as Record<string, string>)[bsonType] ?? "document";
}

type MongoFieldStats = { types: Set<string>; documentIndexes: Set<number>; stringValues: Set<string>; stringObservations: number };
const enumFieldPattern = /(?:^|[._])(status|state|type|category|kind|role|plan|tier|mode|phase|currency|country|locale)$/i;
const sensitiveFieldSegmentPattern = /(?:e?mail|name|phone|mobile|address|token|secret|password|passcode|message|description|content|body|url|uri|ip)$/i;
const isSensitiveField = (path: string) => path.split(/[._-]/).some((segment) => sensitiveFieldSegmentPattern.test(segment));
const looksSensitiveValue = (value: string) => /@|https?:\/\/|\b(?:bearer|token|password|secret)\b/i.test(value) || /^[a-f\d]{24}$/i.test(value) || value.length > 64;

export function profileMongoDocuments(documents: Document[], options: { maxDepth?: number; maxFields?: number; maxArrayElements?: number } = {}): ObjectProfile {
  const maxDepth = options.maxDepth ?? 5; const maxFields = options.maxFields ?? 300; const maxArrayElements = options.maxArrayElements ?? 20;
  const stats = new Map<string, MongoFieldStats>();
  const field = (path: string) => { let current = stats.get(path); if (!current && stats.size < maxFields) { current = { types: new Set(), documentIndexes: new Set(), stringValues: new Set(), stringObservations: 0 }; stats.set(path, current); } return current; };
  const observeString = (current: MongoFieldStats, value: string) => { current.stringObservations += 1; if (!looksSensitiveValue(value) && !/[\r\n]/.test(value) && current.stringValues.size <= 12) current.stringValues.add(value); };
  const visit = (value: unknown, path: string, depth: number, documentIndex: number) => {
    if (!path || depth > maxDepth) return;
    const current = field(path); if (!current) return;
    current.documentIndexes.add(documentIndex);
    if (Array.isArray(value)) {
      const elementTypes = new Set(value.slice(0, maxArrayElements).map(mongoNativeType));
      current.types.add(elementTypes.size ? `array<${[...elementTypes].sort().join("|")}>` : "array");
      for (const element of value.slice(0, maxArrayElements)) {
        if (typeof element === "string") observeString(current, element);
        else if (mongoNativeType(element) === "document" && element !== null && depth < maxDepth) for (const [key, nested] of Object.entries(element as Record<string, unknown>)) visit(nested, `${path}.${key}`, depth + 1, documentIndex);
      }
      return;
    }
    const type = mongoNativeType(value); current.types.add(type);
    if (typeof value === "string") observeString(current, value);
    if (type === "document" && value !== null && depth < maxDepth) for (const [key, nested] of Object.entries(value as Record<string, unknown>)) visit(nested, `${path}.${key}`, depth + 1, documentIndex);
  };
  documents.forEach((document, index) => { for (const [key, value] of Object.entries(document)) visit(value, key, 0, index); });
  const sampledDocuments = documents.length;
  const columns = [...stats.entries()].map(([name, value]): DataColumn => {
    const unique = value.stringValues.size; const ratio = value.stringObservations ? unique / value.stringObservations : 1;
    const enumCandidate = !isSensitiveField(name) && value.stringObservations >= 5 && unique > 0 && unique <= 12 && (ratio <= .25 || enumFieldPattern.test(name) && ratio <= .8);
    const types = [...value.types].sort(); const presence = sampledDocuments ? value.documentIndexes.size / sampledDocuments : 0;
    return { name, nativeType: types.join(" | ") || "unknown", nullable: presence < 1 || types.includes("null"), presence: Math.round(presence * 1000) / 1000, ...(name === "_id" ? { primaryKey: true } : {}), ...(enumCandidate ? { enumValues: [...value.stringValues].sort() } : {}) };
  }).sort((left, right) => left.name === "_id" ? -1 : right.name === "_id" ? 1 : left.name.localeCompare(right.name));
  return { columns, sampledDocuments };
}

export function inferredMongoCollections(field: string, available: string[]): string[] {
  const stripped = field.replace(/(?:_id|Id|ID)$/, "");
  if (!stripped || stripped === field) return [];
  const base = stripped.toLowerCase();
  const variants = new Set([base, `${base}s`, `${base}es`, ...(base.endsWith("y") ? [`${base.slice(0, -1)}ies`] : [])]);
  return available.filter((name) => variants.has(name.toLowerCase()));
}

function mongoReference(value: unknown): { id: ObjectId; collection?: string; database?: string } | undefined {
  let idValue = value;
  let collection: string | undefined;
  let database: string | undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("$ref" in value && typeof value.$ref === "string" && "$id" in value) {
      collection = value.$ref;
      database = "$db" in value && typeof value.$db === "string" ? value.$db : undefined;
      idValue = value.$id;
    }
  }
  try {
    const decoded = idValue instanceof ObjectId ? idValue : BSON.EJSON.deserialize({ value: idValue }).value;
    if (decoded instanceof ObjectId) return { id: decoded, ...(collection ? { collection } : {}), ...(database ? { database } : {}) };
    if (typeof decoded === "string" && /^[a-f\d]{24}$/i.test(decoded)) return { id: new ObjectId(decoded), ...(collection ? { collection } : {}), ...(database ? { database } : {}) };
  } catch { /* not a MongoDB reference */ }
  return undefined;
}

export async function createMongoAdapter(connection: DatabaseConnection, connectionUri: string): Promise<DatabaseAdapter> {
  const client = new MongoClient(connectionUri, { maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 5_000 });
  const describe = async (namespace: string, name: string, options: QueryOptions) => { const sample = await timed(client.db(namespace).collection(name).findOne(), options); if (!sample) return []; return Object.entries(sample).map(([key, value]): DataColumn => ({ name: key, nativeType: mongoNativeType(value), nullable: true, ...(key === "_id" ? { primaryKey: true } : {}) })); };
  return { kind: "mongodb",
    async testConnection(options) { const start = performance.now(); await timed(client.db("admin").command({ ping: 1 }), options); return { latencyMs: Math.round(performance.now() - start) }; },
    async listNamespaces(options) { const result = await timed(client.db("admin").admin().listDatabases({ authorizedDatabases: true, nameOnly: true }), options); return result.databases.map((database) => database.name).sort(); },
    async listObjects(connectionId, options, namespace = connection.database) { const values = await timed(client.db(namespace).listCollections({}, { nameOnly: true }).toArray(), options); const objects = await Promise.all(values.map(async (value): Promise<DataObject> => { const estimatedRows = await timed(client.db(namespace).collection(value.name).estimatedDocumentCount(), { ...options, timeoutMs: Math.min(options.timeoutMs, 2_000) }).catch(() => undefined); return { connectionId, namespace, name: value.name, kind: "collection", ...(estimatedRows === undefined ? {} : { estimatedRows }) }; })); return objects.sort((left, right) => left.name.localeCompare(right.name)); },
    describeObject: describe,
    async profileObject(namespace, name, options) { const configured = Number(process.env.MONGO_SCHEMA_SAMPLE_SIZE ?? 100); const sampleSize = Number.isFinite(configured) ? Math.max(10, Math.min(500, Math.floor(configured))) : 100; const documents = await timed(client.db(namespace).collection(name).aggregate([{ $sample: { size: sampleSize } }], { maxTimeMS: options.timeoutMs }).toArray(), options); return profileMongoDocuments(documents); },
    async explore(request, options) { const start = performance.now(); const offset = decodeCursor(request.cursor); const sort: Record<string, 1 | -1> = Object.fromEntries((request.sort ?? []).map((item) => [item.column, item.direction === "asc" ? 1 : -1])); const filter = mongoFilter(request.filters); const raw = await timed(client.db(request.namespace).collection(request.object).find(filter).sort(sort).skip(offset).limit(request.limit + 1).toArray(), options); const hasMore = raw.length > request.limit; const rows = raw.slice(0, request.limit).map(mongoExtendedJson); if (!withinSize(rows, options.maxResponseBytes)) throw new Error("Response exceeded the configured size limit."); return { columns: await describe(request.namespace, request.object, options), rows, ...(hasMore ? { nextCursor: encodeCursor(offset + rows.length) } : {}), durationMs: Math.round(performance.now() - start), truncated: hasMore }; },
    async countDocuments(request, options) { const start = performance.now(); const filtered = Boolean(request.filters?.length); const collection = client.db(request.namespace).collection(request.object); const count = filtered ? await timed(collection.countDocuments(mongoFilter(request.filters)), options) : await timed(collection.estimatedDocumentCount(), options); return { count, estimated: !filtered, durationMs: Math.round(performance.now() - start) }; },
    async resolveReference(request, options): Promise<ReferenceLookupResult> {
      const reference = mongoReference(request.value);
      if (!reference) return { matches: [], inferredCollections: [], searchedCollections: 0, searchAllAvailable: false, strategy: "none" };
      const database = reference.database ?? request.database;
      const available = (await timed(client.db(database).listCollections({}, { nameOnly: true }).toArray(), options)).map((item) => item.name);
      const inferred = reference.collection ? [reference.collection] : inferredMongoCollections(request.field, available);
      const candidates = (request.searchAll ? available.filter((name) => name !== request.sourceCollection) : inferred).slice(0, 200);
      const found = await timed(mapWithConcurrency(candidates, 8, async (collection) => {
        const document = await client.db(database).collection(collection).findOne({ _id: reference.id });
        return document ? { database, collection, document: mongoExtendedJson(document) } : undefined;
      }), options);
      const matches = found.filter((item): item is NonNullable<typeof item> => item !== undefined).slice(0, 25);
      if (!withinSize(matches.map((match) => match.document), options.maxResponseBytes)) throw new Error("Response exceeded the configured size limit.");
      const strategy = reference.collection ? "dbref" : request.searchAll ? "scan" : inferred.length ? "field" : "none";
      return { matches, inferredCollections: inferred, searchedCollections: candidates.length, searchAllAvailable: !request.searchAll && !reference.collection, strategy };
    },
    async executeReadOnly(query, limit, options, context) { if (!context?.namespace || !context.object) throw new Error("A database and collection context are required for MongoDB queries."); const start = performance.now(); const pipeline = parseReadOnlyMongoPipeline(query); pipeline.push({ $limit: limit + 1 }); const raw = await timed(client.db(context.namespace).collection(context.object).aggregate(pipeline, { maxTimeMS: options.timeoutMs }).toArray(), options); const rows = raw.slice(0, limit).map(mongoExtendedJson); if (!withinSize(rows, options.maxResponseBytes)) throw new Error("Response exceeded the configured size limit."); const first = raw[0]; const columns = first ? Object.entries(first).map(([name, value]): DataColumn => ({ name, nativeType: mongoNativeType(value), nullable: true })) : []; return { columns, rows, durationMs: Math.round(performance.now() - start), truncated: raw.length > limit }; }, async close() { await client.close(); },
  };
}
