import type { AskAgentEvent, AskDraft, AskResult, DataObject, DatabaseConnection } from "@orbit/contracts";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { DataValue } from "./DataValue";
import { LazyResultChart } from "./LazyResultChart";

type AskState = "idle" | "generating" | "ready" | "executing" | "complete";
type TraceEvent = Extract<AskAgentEvent, { type: "progress" | "activity" | "output" }>;

const suggestions = [
  "Summarize the most important patterns in this data",
  "Show the distribution by status",
  "What changed most recently?",
];

function AgentMark() { return <span className="ask-agent-mark" aria-hidden="true">✦</span>; }

export function AskWorkspace({ connection, context, question, state, trace, error, draft, result, onQuestionChange, onGenerate, onQueryChange, onExecute, onDiscard, onNewQuestion, onOpenExplore, onSave }: {
  connection: DatabaseConnection | undefined;
  context: DataObject | undefined;
  question: string;
  state: AskState;
  trace: TraceEvent[];
  error: { code: string; message: string; requestId?: string } | undefined;
  draft: AskDraft | undefined;
  result: AskResult | undefined;
  onQuestionChange: (value: string) => void;
  onGenerate: (event: FormEvent) => void;
  onQueryChange: (value: string) => void;
  onExecute: () => void;
  onDiscard: () => void;
  onNewQuestion: () => void;
  onOpenExplore: () => void;
  onSave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const active = state !== "idle" || Boolean(draft) || Boolean(error);
  const language = draft?.queryLanguage === "mongodb" ? "MongoDB pipeline" : connection?.kind === "mysql" ? "MySQL" : "PostgreSQL";
  const traceSteps = trace.filter((event) => event.type !== "output");
  const latestStep = traceSteps.at(-1);
  const outputByActivity = new Map<string, string>();
  const activityLabels = new Map<string, { message: string; model?: string }>();
  for (const event of trace) {
    if (event.type === "output") outputByActivity.set(event.activityId, `${outputByActivity.get(event.activityId) ?? ""}${event.delta}`);
    if (event.type === "activity" && event.status === "started") activityLabels.set(event.activityId, { message: event.message, ...(event.model ? { model: event.model } : {}) });
  }

  function submitWithKeyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit();
  }

  async function copyQuery() {
    if (!draft) return;
    await navigator.clipboard.writeText(draft.query);
    setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  }

  const composer = <form className="ask-agent-composer" onSubmit={onGenerate}>
    <AgentMark />
    <textarea aria-label="Ask a question" autoFocus={!active} value={question} onChange={(event) => onQuestionChange(event.target.value)} onKeyDown={submitWithKeyboard} placeholder={`Ask about ${context?.name ?? connection?.database ?? "your data"}…`} />
    <div className="ask-composer-meta">{context && <span>◎ {context.namespace}.{context.name}</span>}<small>⌘↵ to generate</small></div>
    <button className="primary" disabled={state === "generating" || state === "executing" || !question.trim()}>{state === "generating" ? "Working…" : "Generate query"}<i>↑</i></button>
  </form>;

  return <div className={`ask-agent-shell${active ? " active" : ""}`}>
    <div className="ask-agent-scroll">
      {!active ? <section className="ask-agent-empty"><AgentMark /><small>ORBIT AI</small><h2>Ask your database.</h2><p>Describe what you want to understand. Orbit will inspect the relevant schema and prepare a read-only query for your review.</p>{composer}<div className="ask-suggestions">{suggestions.map((suggestion) => <button key={suggestion} onClick={() => onQuestionChange(suggestion)}><span>↗</span>{suggestion}</button>)}</div><div className="ask-safety-note"><span>⌾</span><p><strong>You stay in control.</strong> Generated queries are visible, editable, validated, and never run without your approval.</p></div></section> : <section className="ask-thread">
        <article className="ask-user-turn"><div><small>YOU</small><p>{question}</p>{context && <span>Context · {context.namespace}.{context.name}</span>}</div></article>
        <article className="ask-agent-turn"><header><AgentMark /><div><strong>Orbit agent</strong><small>{state === "generating" ? "Preparing query" : state === "executing" ? "Running approved query" : result ? "Answer ready" : error ? "Needs attention" : "Query ready for review"}</small></div><span className={`ask-agent-state ${error ? "error" : result ? "complete" : state}`}>{error ? "failed" : result ? "complete" : state}</span></header>
          {state === "generating" && <div className="ask-agent-live" aria-live="polite"><i className="spinner" /><div><strong>{latestStep?.message ?? "Starting the Ask agent"}</strong><p>{latestStep?.detail ?? "Preparing a transparent, read-only query plan."}</p></div></div>}
          {trace.length > 0 && <details className="ask-activity-inspector"><summary><span><i>{state === "generating" ? <span className="activity-pulse" /> : error ? "!" : "✓"}</i><strong>Agent activity</strong><small>{traceSteps.length} events · {outputByActivity.size} model stream{outputByActivity.size === 1 ? "" : "s"}</small></span><b>⌄</b></summary><div className="ask-activity-body"><p className="ask-activity-disclosure">Shows the operations Orbit performed and the exact provider output received. Hidden chain-of-thought is neither requested nor displayed.</p><div className="ask-activity-timeline">{traceSteps.map((event, index) => <div className={`ask-activity-event ${event.type} ${event.type === "activity" ? event.status : "completed"}`} key={`${event.type}-${event.type === "activity" ? event.activityId : event.stage}-${index}`}><span>{event.type === "activity" && event.status === "started" && state === "generating" && index === traceSteps.length - 1 ? <i className="spinner" /> : event.type === "activity" && event.status === "started" ? "→" : "✓"}</span><div><strong>{event.message}</strong>{event.type === "activity" && event.model && <code>{event.model}</code>}{event.detail && <p>{event.detail}</p>}</div></div>)}</div>{[...outputByActivity].map(([activityId, output]) => { const label = activityLabels.get(activityId); return <section className="ask-raw-output" key={activityId}><header><div><strong>Provider stream</strong><small>{label?.message}{label?.model ? ` · ${label.model}` : ""}</small></div><span>{output.length.toLocaleString()} chars</span></header><pre>{output}</pre></section>; })}</div></details>}
          {error && <div className="ask-agent-error"><strong>{error.code === "AI_NOT_CONFIGURED" ? "AI provider isn’t configured" : "Orbit couldn’t prepare this query"}</strong><p>{error.message}</p>{error.requestId && <code>Request {error.requestId}</code>}<button onClick={onNewQuestion}>Try another question</button></div>}
          {draft && <>
            <div className="ask-agent-intro"><p>I prepared a bounded, read-only {draft.queryLanguage === "mongodb" ? "aggregation pipeline" : "query"}. Review or edit it below, then choose when to run it.</p>{draft.warnings.map((warning) => <div className="ask-query-warning" key={warning}>⚠ {warning}</div>)}</div>
            <section className="ask-query-card"><header><div><span className="query-language-dot" /><div><strong>{language}</strong><small>Generated query · not executed automatically</small></div></div><button onClick={() => void copyQuery()}>{copied ? "Copied" : "Copy"}</button></header><div className="ask-code-editor"><span aria-hidden="true">1</span><textarea aria-label="Generated query" spellCheck={false} value={draft.query} onChange={(event) => onQueryChange(event.target.value)} /></div><div className="ask-query-context"><div><small>SOURCES</small><p>{draft.sourceObjects.map((object) => <span key={`${object.namespace}.${object.name}`}>{object.namespace}.{object.name}</span>)}</p></div><div><small>ASSUMPTIONS</small><p>{draft.assumptions.length ? draft.assumptions.join(" · ") : "None"}</p></div></div><footer><span><i>✓</i> Read-only validation passed</span><button onClick={onDiscard}>Discard</button><button className="primary" disabled={state === "executing"} onClick={onExecute}>{state === "executing" ? <><i className="spinner" /> Running safely…</> : result ? "Run again" : "Run query"}</button></footer></section>
          </>}
          {state === "executing" && <div className="ask-execution-progress"><i className="spinner" /><div><strong>Executing the approved query</strong><p>Fetching bounded evidence and preparing a concise answer.</p></div></div>}
          {result && <section className="ask-answer"><header><div><small>ANSWER</small><h2>{result.answer}</h2></div><span>{result.executionTimeMs} ms</span></header>{result.visualization && result.visualization.kind !== "table" && <LazyResultChart columns={result.evidence.columns} rows={result.evidence.rows} visualization={result.visualization} />}<div className="ask-evidence-heading"><div><strong>Evidence</strong><span>{result.evidence.rows.length}{result.evidence.truncated ? "+" : ""} rows · {result.evidence.columns.length} columns</span></div><button onClick={onOpenExplore}>Open source in Explore</button><button onClick={onSave}>Save as view</button></div><div className="evidence-table"><table><thead><tr>{result.evidence.columns.map((column) => <th key={column.name}>{column.name}<small>{column.nativeType}</small></th>)}</tr></thead><tbody>{result.evidence.rows.slice(0, 50).map((row, index) => <tr key={index}>{result.evidence.columns.map((column) => <td key={column.name}><DataValue fieldName={column.name} nativeType={column.nativeType} enumValues={column.enumValues} value={row[column.name]} mongo={connection?.kind === "mongodb"} postgres={connection?.kind === "postgres"} /></td>)}</tr>)}</tbody></table></div></section>}
        </article>
        {(draft || error) && <div className="ask-thread-actions"><button onClick={onNewQuestion}>＋ New question</button></div>}
      </section>}
    </div>
  </div>;
}
