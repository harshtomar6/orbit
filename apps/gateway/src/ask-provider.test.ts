import { describe, expect, it } from "vitest";
import { formatSchemaContext, normalizeGeneratedQuery, parseRepairedMongoPipeline, parseStructuredModelOutput } from "./ask-provider.js";

describe("OpenAI-compatible structured output", () => {
  it("parses native JSON responses", () => {
    expect(parseStructuredModelOutput('{"query":"SELECT 1"}')).toEqual({ query: "SELECT 1" });
  });

  it("accepts JSON fenced by models that ignore structured-output formatting", () => {
    expect(parseStructuredModelOutput('```json\n{"query":"SELECT 1"}\n```')).toEqual({ query: "SELECT 1" });
  });

  it("normalizes fenced SQL and raw MongoDB pipelines as query plans", () => {
    expect(parseStructuredModelOutput("```sql\nSELECT 1\n```")) .toEqual({ query: "SELECT 1" });
    expect(parseStructuredModelOutput('[{"$match":{"active":true}}]')).toEqual({ query: '[{"$match":{"active":true}}]' });
  });

  it("normalizes partial plans only when their source can be inferred", () => {
    const schema = [{ object: { connectionId: "demo", namespace: "public", name: "users", kind: "table" as const }, columns: [] }];
    expect(normalizeGeneratedQuery({ query: "SELECT plan, COUNT(*) FROM public.users GROUP BY plan" }, schema)).toMatchObject({ assumptions: [], sourceObjects: ["public.users"], visualization: { kind: "table", x: null, y: [] } });
    expect(normalizeGeneratedQuery({ query: "SELECT plan FROM public.users", sourceObjects: ["users"] }, schema).sourceObjects).toEqual(["public.users"]);
  });

  it("serializes a MongoDB query returned as an array", () => {
    const schema = [{ object: { connectionId: "demo", namespace: "demo", name: "users", kind: "collection" as const }, columns: [] }];
    expect(normalizeGeneratedQuery({ query: [{ $match: { active: true } }], sourceObjects: ["demo.users"] }, schema).query).toBe('[{"$match":{"active":true}}]');
  });

  it("serializes a repaired Mongo pipeline back to strict JSON", () => {
    expect(parseRepairedMongoPipeline('```json\n{"pipeline":[{"$match":{"createdAt":{"$gte":{"$date":"2026-01-01T00:00:00Z"}}}}]}\n```')).toBe('[{"$match":{"createdAt":{"$gte":{"$date":"2026-01-01T00:00:00Z"}}}}]');
  });

  it("formats nested Mongo fields, presence, and enum candidates for the model", () => {
    const schema = [{ object: { connectionId: "demo", namespace: "app", name: "users", kind: "collection" as const }, columns: [
      { name: "profile.status", nativeType: "string", nullable: false, presence: .9, enumValues: ["active", "paused"] },
      { name: "roles", nativeType: "array<string>", nullable: true, presence: .7 },
    ] }];
    expect(formatSchemaContext(schema)).toContain('profile.status string present 90% enum ["active","paused"]');
    expect(formatSchemaContext(schema)).toContain("roles array<string> present 70%");
  });
});
