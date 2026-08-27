import { z } from "zod";

export const databaseKindSchema = z.enum(["postgres", "mysql", "mongodb"]);
export const connectionEnvironmentSchema = z.enum(["development", "staging", "production"]);

export const databaseConnectionSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), kind: databaseKindSchema,
  environment: connectionEnvironmentSchema, database: z.string().min(1), readOnly: z.boolean(),
  status: z.enum(["healthy", "unavailable", "checking"]), latencyMs: z.number().nonnegative().optional(),
  lastSchemaRefresh: z.string().datetime().optional(), accessLevel: z.enum(["read_only", "read_write"]),
  demo: z.boolean().optional(), local: z.boolean().optional(),
});
const connectionInputBaseSchema = z.object({
  name: z.string().trim().min(1).max(100), kind: databaseKindSchema,
  environment: connectionEnvironmentSchema, host: z.string().trim().max(255).default(""),
  port: z.number().int().min(0).max(65535).default(0), database: z.string().trim().max(128).default(""),
  username: z.string().trim().max(128).default(""), password: z.string().max(4096).default(""),
  tls: z.boolean().default(true), connectionString: z.string().trim().min(1).max(8192).optional(),
});
export const connectionInputSchema = connectionInputBaseSchema.superRefine((input, context) => {
  if (input.connectionString) {
    let protocol = "";
    let database = "";
    try { const parsed = new URL(input.connectionString); protocol = parsed.protocol; database = decodeURIComponent(parsed.pathname.replace(/^\//, "")); } catch { /* reported below */ }
    const validProtocol = input.kind === "postgres" ? protocol === "postgres:" || protocol === "postgresql:" : input.kind === "mongodb" ? protocol === "mongodb:" || protocol === "mongodb+srv:" : false;
    if (!validProtocol) context.addIssue({ code: "custom", path: ["connectionString"], message: input.kind === "postgres" ? "PostgreSQL connection strings must start with postgres:// or postgresql://." : input.kind === "mongodb" ? "MongoDB connection strings must start with mongodb:// or mongodb+srv://." : "Connection strings are not supported for this database." });
    if (input.kind === "postgres" && !database) context.addIssue({ code: "custom", path: ["connectionString"], message: "The PostgreSQL connection string must include a database name." });
    return;
  }
  for (const [field, value] of [["host", input.host], ["database", input.database], ["username", input.username], ["password", input.password]] as const) if (!value) context.addIssue({ code: "custom", path: [field], message: `${field.charAt(0).toUpperCase() + field.slice(1)} is required.` });
  if (input.port < 1) context.addIssue({ code: "custom", path: ["port"], message: "Port is required." });
});
export const connectionUpdateSchema = connectionInputBaseSchema.partial().extend({ password: z.string().min(1).max(4096).optional() });
export const dataObjectSchema = z.object({
  connectionId: z.string().min(1), namespace: z.string(), name: z.string().min(1),
  kind: z.enum(["table", "view", "collection"]), estimatedRows: z.number().int().nonnegative().optional(),
});
export const dataColumnReferenceSchema = z.object({ namespace: z.string().min(1), object: z.string().min(1), column: z.string().min(1) });
export const dataColumnSchema = z.object({
  name: z.string().min(1), nativeType: z.string().min(1), nullable: z.boolean(), primaryKey: z.boolean().optional(), reference: dataColumnReferenceSchema.optional(), enumValues: z.array(z.string()).optional(), presence: z.number().min(0).max(1).optional(),
});
export const exploreFilterSchema = z.object({
  column: z.string().min(1), operator: z.enum(["eq", "neq", "contains", "gt", "lt"]), value: z.unknown(),
});
export const exploreSortSchema = z.object({ column: z.string().min(1), direction: z.enum(["asc", "desc"]) });
export const exploreRequestSchema = z.object({
  connectionId: z.string().min(1), namespace: z.string(), object: z.string().min(1),
  cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200),
  filters: z.array(exploreFilterSchema).max(20).optional(), sort: z.array(exploreSortSchema).max(5).optional(),
  search: z.string().max(200).optional(),
});
export const exploreResultSchema = z.object({
  columns: z.array(dataColumnSchema), rows: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().optional(), totalRows: z.number().int().nonnegative().optional(), durationMs: z.number().nonnegative(), truncated: z.boolean(),
});
export const documentCountRequestSchema = exploreRequestSchema.pick({ connectionId: true, namespace: true, object: true, filters: true });
export const documentCountResultSchema = z.object({
  count: z.number().int().nonnegative(), estimated: z.boolean(), durationMs: z.number().nonnegative(),
});
export const objectListResultSchema = z.object({ objects: z.array(dataObjectSchema), namespaces: z.array(z.string()).optional(), refreshedAt: z.string().datetime() });
export const referenceLookupRequestSchema = z.object({
  connectionId: z.string().min(1), database: z.string().min(1), sourceCollection: z.string().min(1),
  field: z.string().min(1), value: z.unknown(), searchAll: z.boolean().default(false), reference: dataColumnReferenceSchema.optional(),
});
export const linkedDocumentSchema = z.object({ database: z.string(), collection: z.string(), document: z.record(z.string(), z.unknown()), columns: z.array(dataColumnSchema).optional() });
export const referenceLookupResultSchema = z.object({
  matches: z.array(linkedDocumentSchema), inferredCollections: z.array(z.string()), searchedCollections: z.number().int().nonnegative(),
  searchAllAvailable: z.boolean(), strategy: z.enum(["foreign_key", "dbref", "field", "scan", "none"]),
});
export const askRequestSchema = z.object({
  connectionIds: z.array(z.string().min(1)).length(1), question: z.string().trim().min(3).max(2000),
  context: z.object({ namespace: z.string().optional(), object: z.string().optional() }).optional(),
});
export const visualizationSchema = z.object({ kind: z.enum(["line", "bar", "donut", "table"]), x: z.string().optional(), y: z.array(z.string()).optional() });
export const askDraftSchema = z.object({
  connectionId: z.string(), question: z.string(), query: z.string().min(1), queryLanguage: z.enum(["sql", "mongodb"]),
  assumptions: z.array(z.string()), sourceObjects: z.array(dataObjectSchema), visualization: visualizationSchema,
  warnings: z.array(z.string()),
});
export const askAgentStageSchema = z.enum(["discovering", "inspecting", "generating", "validating"]);
export const askAgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), stage: askAgentStageSchema, message: z.string(), detail: z.string().optional() }),
  z.object({ type: z.literal("activity"), activityId: z.string(), stage: askAgentStageSchema, status: z.enum(["started", "completed"]), message: z.string(), detail: z.string().optional(), model: z.string().optional() }),
  z.object({ type: z.literal("output"), activityId: z.string(), stage: askAgentStageSchema, delta: z.string() }),
  z.object({ type: z.literal("draft"), draft: askDraftSchema }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string(), requestId: z.string().optional() }),
]);
export const askExecuteRequestSchema = z.object({
  connectionId: z.string().min(1), question: z.string().trim().min(3).max(2000), query: z.string().min(1).max(50_000),
  queryLanguage: z.enum(["sql", "mongodb"]), visualization: visualizationSchema.optional(),
  assumptions: z.array(z.string().max(500)).max(10).default([]), sourceObjects: z.array(dataObjectSchema).max(20).default([]),
});
export const savedViewSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explore"), namespace: z.string(), object: z.string(), filters: z.array(exploreFilterSchema).max(20).default([]), sort: z.array(exploreSortSchema).max(5).default([]) }),
  z.object({ kind: z.literal("query"), question: z.string(), query: z.string().min(1).max(50_000), queryLanguage: z.enum(["sql", "mongodb"]), assumptions: z.array(z.string()).default([]), sourceObjects: z.array(dataObjectSchema).min(1).max(20) }),
]);
export const dashboardLayoutSchema = z.object({ x: z.number().int().min(0).max(11), y: z.number().int().min(0), width: z.number().int().min(2).max(12), height: z.number().int().min(2).max(12) });
export const savedViewSchema = z.object({
  id: z.string(), name: z.string().min(1).max(100), connectionId: z.string(), component: z.enum(["table", "metric", "line", "bar", "donut"]),
  source: savedViewSourceSchema, visualization: visualizationSchema, layout: dashboardLayoutSchema,
  refresh: z.object({ mode: z.literal("manual") }), status: z.enum(["fresh", "stale", "failed", "refreshing", "unavailable_connection"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), lastRefreshedAt: z.string().datetime().optional(), lastError: z.string().optional(), shared: z.boolean(),
});
export const createSavedViewSchema = savedViewSchema.pick({ name: true, connectionId: true, component: true, source: true, visualization: true }).extend({ layout: dashboardLayoutSchema.optional() });
export const updateSavedViewSchema = z.object({ name: z.string().min(1).max(100).optional(), component: z.enum(["table", "metric", "line", "bar", "donut"]).optional(), visualization: visualizationSchema.optional(), layout: dashboardLayoutSchema.optional() });
export const savedViewRefreshResultSchema = z.object({ view: savedViewSchema, result: exploreResultSchema });
export const publicSavedViewSchema = savedViewSchema.pick({ id: true, name: true, component: true, visualization: true, status: true, updatedAt: true, lastRefreshedAt: true });
export const sharedViewResultSchema = z.object({ view: publicSavedViewSchema, result: exploreResultSchema });
export const shareResultSchema = z.object({ token: z.string(), url: z.string() });
export const apiErrorSchema = z.object({
  code: z.string(), message: z.string(), requestId: z.string(), details: z.unknown().optional(),
});

export type DatabaseKind = z.infer<typeof databaseKindSchema>;
export type ConnectionEnvironment = z.infer<typeof connectionEnvironmentSchema>;
export type DatabaseConnection = z.infer<typeof databaseConnectionSchema>;
export type ConnectionInput = z.infer<typeof connectionInputSchema>;
export type ConnectionUpdate = z.infer<typeof connectionUpdateSchema>;
export type DataObject = z.infer<typeof dataObjectSchema>;
export type DataColumn = z.infer<typeof dataColumnSchema>;
export type ExploreFilter = z.infer<typeof exploreFilterSchema>;
export type ExploreSort = z.infer<typeof exploreSortSchema>;
export type ExploreRequest = z.infer<typeof exploreRequestSchema>;
export type ExploreResult = z.infer<typeof exploreResultSchema>;
export type DocumentCountRequest = z.infer<typeof documentCountRequestSchema>;
export type DocumentCountResult = z.infer<typeof documentCountResultSchema>;
export type ObjectListResult = z.infer<typeof objectListResultSchema>;
export type ReferenceLookupRequest = z.infer<typeof referenceLookupRequestSchema>;
export type LinkedDocument = z.infer<typeof linkedDocumentSchema>;
export type ReferenceLookupResult = z.infer<typeof referenceLookupResultSchema>;
export type AskRequest = z.infer<typeof askRequestSchema>;
export type AskDraft = z.infer<typeof askDraftSchema>;
export type AskAgentStage = z.infer<typeof askAgentStageSchema>;
export type AskAgentEvent = z.infer<typeof askAgentEventSchema>;
export type AskExecuteRequest = z.infer<typeof askExecuteRequestSchema>;
export type SavedViewSource = z.infer<typeof savedViewSourceSchema>;
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type CreateSavedView = z.infer<typeof createSavedViewSchema>;
export type UpdateSavedView = z.infer<typeof updateSavedViewSchema>;
export type SavedViewRefreshResult = z.infer<typeof savedViewRefreshResultSchema>;
export type SharedViewResult = z.infer<typeof sharedViewResultSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;

export interface AskResult {
  answer: string; query: string; queryLanguage: "sql" | "mongodb"; evidence: ExploreResult;
  assumptions: string[]; executionTimeMs: number; sourceObjects: DataObject[];
  visualization?: { kind: "line" | "bar" | "donut" | "table"; x?: string; y?: string[] };
}
