import type { DataColumn } from "@orbit/contracts";

export type PostgresValueTone = "reference" | "date" | "id" | "number" | "json" | "binary" | "network" | "code";

export interface PostgresValueFormat {
  tag: string;
  text: string;
  title: string;
  tone: PostgresValueTone;
  target?: string;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const raw = (value: unknown) => typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);

function parsedDate(value: unknown, dateOnly: boolean): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const candidate = dateOnly ? `${String(value).slice(0, 10)}T00:00:00Z` : String(value).replace(" ", "T");
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatPostgresValue(value: unknown, nativeType: string | undefined, reference?: DataColumn["reference"]): PostgresValueFormat | undefined {
  if (value === null || value === undefined || !nativeType) return undefined;
  const type = nativeType.trim().toLowerCase();
  const exact = raw(value);

  if (reference) {
    const target = `${reference.namespace}.${reference.object}.${reference.column}`;
    return { tag: "FK", text: exact, target, title: `${exact} references ${target}`, tone: "reference" };
  }
  if (type === "uuid") return { tag: "UUID", text: exact, title: exact, tone: "id" };
  if (type === "date") { const date = parsedDate(value, true); return { tag: "DATE", text: date ? dateFormat.format(date) : exact, title: exact, tone: "date" }; }
  if (type.includes("timestamp")) { const date = parsedDate(value, false); const zoned = type.includes("with time zone") || type === "timestamptz"; return { tag: zoned ? "TIMESTAMPTZ" : "TIMESTAMP", text: date ? dateTimeFormat.format(date) : exact, title: exact, tone: "date" }; }
  if (type.startsWith("time")) return { tag: type.includes("with time zone") ? "TIMETZ" : "TIME", text: exact, title: exact, tone: "date" };
  if (type === "json" || type === "jsonb") { const count = value !== null && typeof value === "object" ? Object.keys(value).length : undefined; return { tag: type.toUpperCase(), text: count === undefined ? exact : `${Array.isArray(value) ? "array" : "object"} · ${count} ${Array.isArray(value) ? "items" : "fields"}`, title: exact, tone: "json" }; }
  if (type.endsWith("[]") || Array.isArray(value)) { const count = Array.isArray(value) ? value.length : undefined; return { tag: "ARRAY", text: count === undefined ? exact : `${count} items`, title: exact, tone: "json" }; }
  if (type === "bytea") return { tag: "BYTEA", text: exact.length > 32 ? `${exact.slice(0, 32)}…` : exact, title: exact, tone: "binary" };
  if (["inet", "cidr", "macaddr", "macaddr8"].includes(type)) return { tag: type.toUpperCase(), text: exact, title: exact, tone: "network" };
  if (type.startsWith("numeric") || type.startsWith("decimal") || type === "money") return { tag: type.startsWith("decimal") ? "DECIMAL" : type === "money" ? "MONEY" : "NUMERIC", text: exact, title: exact, tone: "number" };
  if (type.startsWith("interval")) return { tag: "INTERVAL", text: exact, title: exact, tone: "date" };
  if (["tsvector", "tsquery", "xml"].includes(type)) return { tag: type.toUpperCase(), text: exact, title: exact, tone: "code" };
  return undefined;
}
