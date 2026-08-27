import type { AskDraft, DatabaseConnection } from "@orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AskWorkspace } from "./AskWorkspace";

describe("AskWorkspace", () => {
  const connection: DatabaseConnection = { id: "demo_postgres", name: "Orbit sample", kind: "postgres", environment: "development", database: "orbit_sample", readOnly: true, status: "healthy", accessLevel: "read_only" };
  const draft: AskDraft = { connectionId: connection.id, question: "Show users by plan", query: "SELECT plan, COUNT(*) FROM public.users GROUP BY plan LIMIT 200", queryLanguage: "sql", assumptions: ["Each user has one plan."], sourceObjects: [{ connectionId: connection.id, namespace: "public", name: "users", kind: "table", estimatedRows: 5 }], visualization: { kind: "table" }, warnings: [] };

  it("keeps the generated query visible and requires an explicit run action", () => {
    const action = vi.fn();
    const html = renderToStaticMarkup(<AskWorkspace connection={connection} context={draft.sourceObjects[0]} question={draft.question} state="ready" trace={[{ type: "progress", stage: "discovering", message: "Finding relevant data" }, { type: "activity", activityId: "query-generation", stage: "generating", status: "started", message: "Requesting a query plan", model: "openai/gpt-5.4" }, { type: "output", activityId: "query-generation", stage: "generating", delta: '{"query":"SELECT plan"}' }]} error={undefined} draft={draft} result={undefined} onQuestionChange={action} onGenerate={action} onQueryChange={action} onExecute={action} onDiscard={action} onNewQuestion={action} onOpenExplore={action} onSave={action} />);
    expect(html).toContain("SELECT plan, COUNT(*)");
    expect(html).toContain("Generated query · not executed automatically");
    expect(html).toContain("Read-only validation passed");
    expect(html).toContain("Run query");
    expect(html).toContain("Agent activity");
    expect(html).toContain("Provider stream");
    expect(html).toContain("openai/gpt-5.4");
    expect(html).toContain("<details class=\"ask-activity-inspector\">");
  });
});
