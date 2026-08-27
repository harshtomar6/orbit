import type { DataColumn } from "@orbit/contracts";
import { formatMongoValue, mongoReference } from "../lib/mongo-format";
import { formatPostgresValue } from "../lib/postgres-format";
import { enumTone, parseStatus } from "../lib/status-format";

const display = (value: unknown) => value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);

type JsonContainer = Record<string, unknown> | unknown[];

export function parseJsonContainer(value: unknown): { value: JsonContainer; fromString: boolean } | undefined {
  if (Array.isArray(value)) return { value, fromString: false };
  if (typeof value === "object" && value !== null) return { value: value as Record<string, unknown>, fromString: false };
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!(candidate.startsWith("{") && candidate.endsWith("}")) && !(candidate.startsWith("[") && candidate.endsWith("]"))) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null) ? { value: parsed as JsonContainer, fromString: true } : undefined;
  } catch {
    return undefined;
  }
}

function JsonTree({ container, mongo, fromString = false }: { container: JsonContainer; mongo: boolean; fromString?: boolean }) {
  const entries = Array.isArray(container) ? container.map((item, index) => [`[${index}]`, item] as const) : Object.entries(container);
  const kind = Array.isArray(container) ? "array" : "object";
  const unit = Array.isArray(container) ? "items" : "fields";
  return <details className="json-tree" onClick={(event) => event.stopPropagation()}>
    <summary><span className="json-tree-chevron">›</span>{fromString && <small>JSON</small>}<code>{kind} · {entries.length} {unit}</code></summary>
    <div className="json-tree-children">{entries.map(([key, item]) => <div className="json-tree-row" key={key}><span className="json-tree-key">{key}</span><div className="json-tree-value"><DataValue fieldName={Array.isArray(container) ? undefined : key} value={item} mongo={mongo} expanded /></div></div>)}</div>
  </details>;
}

export function DataValue({ value, fieldName, nativeType, reference, enumValues, mongo = false, postgres = false, expanded = false, onReference }: { value: unknown; fieldName?: string | undefined; nativeType?: string | undefined; reference?: DataColumn["reference"]; enumValues?: string[] | undefined; mongo?: boolean; postgres?: boolean; expanded?: boolean; onReference?: (() => void) | undefined }) {
  const status = parseStatus(fieldName, value);
  const postgresEnum = postgres && enumValues?.length && typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (status || postgresEnum) {
    const label = status?.label ?? postgresEnum!;
    const title = postgresEnum ? `PostgreSQL enum ${nativeType ?? ""} · Allowed: ${enumValues!.join(", ")}` : `${fieldName}: ${label}`;
    const tone = postgresEnum ? enumTone(label, enumValues!) : status!.tone;
    const badge = <span className={`status-badge ${tone}`} title={title}><i />{label}</span>;
    return reference && onReference
      ? <button className="status-reference" type="button" title={`Open referenced row in ${reference.namespace}.${reference.object}`} onClick={(event) => { event.stopPropagation(); onReference(); }}>{badge}<i>↗</i></button>
      : badge;
  }
  const formatted = mongo ? formatMongoValue(value) : undefined;
  const mongoRef = mongo ? mongoReference(value) : undefined;
  if (formatted) {
    const content = <><small>{formatted.tag}</small><code>{formatted.text}</code>{mongoRef && onReference ? <i>↗</i> : null}</>;
    return mongoRef && onReference
      ? <button className={`mongo-value mongo-reference ${formatted.tone}`} type="button" title={`Open linked document for ${mongoRef.id}`} onClick={(event) => { event.stopPropagation(); onReference(); }}>{content}</button>
      : <span className={`mongo-value ${formatted.tone}`} title={formatted.title}>{content}</span>;
  }
  const json = parseJsonContainer(value);
  if (expanded && json) return <JsonTree container={json.value} mongo={mongo} fromString={json.fromString} />;
  const postgresFormatted = postgres ? formatPostgresValue(value, nativeType, reference) : undefined;
  if (postgresFormatted) {
    const content = <><small>{postgresFormatted.tag}</small><code>{postgresFormatted.text}</code>{postgresFormatted.target && <em>→ {postgresFormatted.target}</em>}{reference && onReference ? <i>↗</i> : null}</>;
    return reference && onReference
      ? <button className={`postgres-value postgres-reference ${postgresFormatted.tone}`} type="button" title={`Open referenced row in ${reference.namespace}.${reference.object}`} onClick={(event) => { event.stopPropagation(); onReference(); }}>{content}</button>
      : <span className={`postgres-value ${postgresFormatted.tone}`} title={postgresFormatted.title}>{content}</span>;
  }
  if (value === null) return <span className="data-value null">null</span>;
  if (value === undefined) return <span className="data-value null">—</span>;
  if (typeof value === "boolean") return <span className="data-value boolean">{String(value)}</span>;
  if (typeof value === "number") return <span className="data-value number">{value.toLocaleString()}</span>;
  if (typeof value === "object") return <code className={`data-value document${expanded ? " expanded" : ""}`} title={expanded ? undefined : display(value)}>{JSON.stringify(value, null, expanded ? 2 : 0)}</code>;
  return <span className="data-value string">{String(value)}</span>;
}
