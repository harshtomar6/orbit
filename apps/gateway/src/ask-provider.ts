import type { AskAgentEvent, DataColumn, DataObject, DatabaseConnection, ExploreResult } from "@orbit/contracts";
import OpenAI from "openai";
import { z } from "zod";

const generatedQuerySchema = z.object({
  query: z.string().min(1), assumptions: z.array(z.string()).max(10), sourceObjects: z.array(z.string()).min(1).max(20),
  visualization: z.object({ kind: z.enum(["line", "bar", "donut", "table"]), x: z.string().nullable(), y: z.array(z.string()) }),
});
export type GeneratedQuery = z.infer<typeof generatedQuerySchema>;
export interface SchemaContext { object: DataObject; columns: DataColumn[] }
export type AskProviderReporter = (event: Extract<AskAgentEvent, { type: "activity" | "output" }>) => void | Promise<void>;
export interface AskProvider {
  generateQuery(input: { connection: DatabaseConnection; question: string; schema: SchemaContext[] }, report?: AskProviderReporter): Promise<GeneratedQuery>;
  repairMongoPipeline?(input: { connection: DatabaseConnection; question: string; query: string }, report?: AskProviderReporter): Promise<string>;
  summarize?(input: { connection: DatabaseConnection; question: string; query: string; evidence: ExploreResult; assumptions: string[] }): Promise<string>;
}

const outputJsonSchema = {
  type: "object", additionalProperties: false, required: ["query", "assumptions", "sourceObjects", "visualization"],
  properties: {
    query: { type: "string" }, assumptions: { type: "array", maxItems: 10, items: { type: "string" } },
    sourceObjects: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", description: "Exact namespace.name from the supplied schema" } },
    visualization: { type: "object", additionalProperties: false, required: ["kind", "x", "y"], properties: { kind: { type: "string", enum: ["line", "bar", "donut", "table"] }, x: { type: ["string", "null"] }, y: { type: "array", items: { type: "string" } } } },
  },
};

export function parseStructuredModelOutput(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```[^\r\n]*\r?\n?/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    const parsed: unknown = JSON.parse(unfenced);
    if (typeof parsed === "string") return { query: parsed };
    if (Array.isArray(parsed)) return { query: JSON.stringify(parsed) };
    return parsed;
  } catch {
    return { query: unfenced };
  }
}

export function normalizeGeneratedQuery(value: unknown, schema: SchemaContext[]): GeneratedQuery {
  const partial = z.object({
    query: z.union([z.string().min(1), z.array(z.record(z.string(), z.unknown())).min(1).max(50)]),
    assumptions: z.array(z.string()).optional(),
    sourceObjects: z.array(z.string()).optional(),
    visualization: z.object({ kind: z.enum(["line", "bar", "donut", "table"]), x: z.string().nullable().optional(), y: z.array(z.string()).optional() }).optional(),
  }).parse(value);
  const normalizedQuery = typeof partial.query === "string" ? partial.query : JSON.stringify(partial.query);
  const query = normalizedQuery.toLowerCase();
  const inferredSources = schema.filter(({ object }) => {
    const qualified = `${object.namespace}.${object.name}`.toLowerCase();
    const escapedName = object.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return query.includes(qualified) || new RegExp(`(?:^|[^a-z0-9_])${escapedName.toLowerCase()}(?:$|[^a-z0-9_])`).test(query);
  }).map(({ object }) => `${object.namespace}.${object.name}`);
  const availableSources = new Map(schema.map(({ object }) => [`${object.namespace}.${object.name}`.toLowerCase(), `${object.namespace}.${object.name}`]));
  const validatedSources = partial.sourceObjects?.map((source) => availableSources.get(source.trim().toLowerCase())).filter((source): source is string => source !== undefined) ?? [];
  const sourceObjects = validatedSources.length ? validatedSources : inferredSources.length ? inferredSources : schema.length === 1 ? [`${schema[0]!.object.namespace}.${schema[0]!.object.name}`] : [];
  return generatedQuerySchema.parse({
    query: normalizedQuery,
    assumptions: partial.assumptions ?? [],
    sourceObjects,
    visualization: { kind: partial.visualization?.kind ?? "table", x: partial.visualization?.x ?? null, y: partial.visualization?.y ?? [] },
  });
}

export function parseRepairedMongoPipeline(content: string): string {
  const value = parseStructuredModelOutput(content);
  const pipeline = z.object({ pipeline: z.array(z.record(z.string(), z.unknown())).min(1).max(50) }).parse(value).pipeline;
  return JSON.stringify(pipeline);
}

export function formatSchemaContext(schema: SchemaContext[], maxFields = 600): string {
  let remaining = Math.max(1, Math.floor(maxFields));
  return schema.map(({ object, columns }) => {
    const included = columns.slice(0, remaining); remaining -= included.length;
    const fields = included.map((column) => {
      const details = [column.name, column.nativeType];
      if (column.presence !== undefined) details.push(`present ${Math.round(column.presence * 100)}%`);
      else details.push(column.nullable ? "nullable" : "required");
      if (column.primaryKey) details.push("primary key");
      if (column.enumValues?.length) details.push(`enum ${JSON.stringify(column.enumValues)}`);
      if (column.reference) details.push(`references ${column.reference.namespace}.${column.reference.object}.${column.reference.column}`);
      return details.join(" ");
    });
    const omitted = columns.length - included.length;
    return `${object.namespace}.${object.name} (${object.kind}): ${fields.join(", ")}${omitted > 0 ? `, … ${omitted} fields omitted` : ""}`;
  }).join("\n");
}

export class OpenAICompatibleAskProvider implements AskProvider {
  readonly #client: OpenAI; readonly #model: string;
  constructor({ apiKey, model = "openai/gpt-5.4", baseURL = "https://openrouter.ai/api/v1", siteUrl, appName = "Orbit" }: { apiKey: string; model?: string; baseURL?: string; siteUrl?: string; appName?: string }) {
    this.#client = new OpenAI({ apiKey, baseURL, defaultHeaders: { ...(siteUrl ? { "HTTP-Referer": siteUrl } : {}), "X-OpenRouter-Title": appName } });
    this.#model = model;
  }
  async generateQuery({ connection, question, schema }: { connection: DatabaseConnection; question: string; schema: SchemaContext[] }, report: AskProviderReporter = async () => undefined): Promise<GeneratedQuery> {
    const dialect = connection.kind === "mongodb" ? "MongoDB aggregation pipeline JSON array" : connection.kind === "mysql" ? "MySQL SQL" : "PostgreSQL SQL";
    const configuredFieldLimit = Number(process.env.ASK_SCHEMA_FIELD_LIMIT ?? 600);
    const schemaText = formatSchemaContext(schema, Number.isFinite(configuredFieldLimit) ? Math.max(50, Math.min(2_000, configuredFieldLimit)) : 600);
    const activityId = "query-generation";
    await report({ type: "activity", activityId, stage: "generating", status: "started", message: "Requesting a query plan", detail: "Streaming the provider response", model: this.#model });
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: [
        { role: "system", content: `You generate one read-only ${dialect} query for a database analyst. Never generate mutations, DDL, administrative commands, stored procedures, code execution, or multiple statements. Use only supplied objects and columns. Keep results bounded and suitable for evidence. For MongoDB, query must contain only a strict JSON aggregation-pipeline array: use double-quoted keys and values, no db.collection.aggregate wrapper, and no JavaScript constructors such as ObjectId(), ISODate(), RegExp(), or NumberLong(). Represent special values with MongoDB Extended JSON objects. sourceObjects must use exact namespace.name values. Choose table unless a chart clearly improves comprehension. For a chart, x and y must be exact result-column names or aliases produced by the query, and every y field must be numeric.` },
        { role: "user", content: `Database: ${connection.kind} / ${connection.database}\nQuestion: ${question}\nAvailable schema:\n${schemaText}` },
      ],
      response_format: { type: "json_schema", json_schema: { name: "orbit_query_plan", strict: true, schema: outputJsonSchema } },
      stream: true,
    });
    let content = "";
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta.content;
      if (!delta) continue;
      content += delta;
      await report({ type: "output", activityId, stage: "generating", delta });
    }
    if (!content) throw new Error("The model did not return a query plan.");
    await report({ type: "activity", activityId, stage: "generating", status: "completed", message: "Query plan received", detail: `${content.length.toLocaleString()} characters returned`, model: this.#model });
    return normalizeGeneratedQuery(parseStructuredModelOutput(content), schema);
  }
  async repairMongoPipeline({ connection, question, query }: { connection: DatabaseConnection; question: string; query: string }, report: AskProviderReporter = async () => undefined): Promise<string> {
    const activityId = "mongo-repair";
    await report({ type: "activity", activityId, stage: "validating", status: "started", message: "Requesting strict MongoDB JSON", detail: "The first response used non-JSON Mongo shell syntax", model: this.#model });
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: [
        { role: "system", content: "Convert the candidate into one strict MongoDB aggregation pipeline. Return a JSON object with exactly one field named pipeline whose value is a non-empty JSON array of aggregation-stage objects. Remove db.collection.aggregate wrappers and prose. Use valid JSON with double-quoted keys and values. Never use JavaScript constructors such as ObjectId(), ISODate(), RegExp(), or NumberLong(); represent special values with MongoDB Extended JSON objects such as {\"$oid\":\"...\"} and {\"$date\":\"...\"}. Preserve the read-only intent and never introduce $out, $merge, $function, $accumulator, or $where." },
        { role: "user", content: `Database: ${connection.database}\nQuestion: ${question}\nCandidate output:\n${query}` },
      ],
      response_format: { type: "json_object" },
      stream: true,
    });
    let content = "";
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta.content;
      if (!delta) continue;
      content += delta;
      await report({ type: "output", activityId, stage: "validating", delta });
    }
    if (!content) throw new Error("The model did not return a repaired MongoDB pipeline.");
    await report({ type: "activity", activityId, stage: "validating", status: "completed", message: "MongoDB syntax repaired", detail: `${content.length.toLocaleString()} characters returned`, model: this.#model });
    return parseRepairedMongoPipeline(content);
  }
  async summarize({ connection, question, query, evidence, assumptions }: { connection: DatabaseConnection; question: string; query: string; evidence: ExploreResult; assumptions: string[] }): Promise<string> {
    const evidenceText = JSON.stringify({ columns: evidence.columns.map((column) => column.name), rows: evidence.rows.slice(0, 50), truncated: evidence.truncated }).slice(0, 24_000);
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: [
        { role: "system", content: "Answer the analyst's question using only the supplied query evidence. Be concise and direct. Mention uncertainty or truncation when it materially affects the answer. Do not invent values, expose hidden reasoning, or repeat the query. Return plain text with at most three short paragraphs." },
        { role: "user", content: `Database: ${connection.kind}\nQuestion: ${question}\nExecuted read-only query:\n${query}\nAssumptions: ${assumptions.join("; ") || "None"}\nEvidence:\n${evidenceText}` },
      ],
    });
    return response.choices[0]?.message.content?.trim() || "The query completed, but no narrative answer was produced.";
  }
}

export class AiNotConfiguredError extends Error { constructor() { super("Ask requires OPENROUTER_API_KEY on the gateway."); this.name = "AiNotConfiguredError"; } }
export class UnconfiguredAskProvider implements AskProvider { async generateQuery(): Promise<GeneratedQuery> { throw new AiNotConfiguredError(); } }
export function createAskProvider(): AskProvider {
  const apiKey = process.env.ORBIT_LLM_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return new UnconfiguredAskProvider();
  return new OpenAICompatibleAskProvider({ apiKey, model: process.env.ORBIT_LLM_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-5.4", baseURL: process.env.ORBIT_LLM_BASE_URL ?? "https://openrouter.ai/api/v1", ...(process.env.OPENROUTER_SITE_URL ? { siteUrl: process.env.OPENROUTER_SITE_URL } : {}), appName: process.env.OPENROUTER_APP_NAME ?? "Orbit" });
}
