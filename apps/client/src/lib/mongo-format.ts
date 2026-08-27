export type MongoValueTone = "id" | "date" | "number" | "binary" | "pattern" | "code";

export interface MongoValueFormat {
  tag: string;
  text: string;
  title: string;
  tone: MongoValueTone;
}

export interface MongoReference { id: string; collection?: string; database?: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const exact = (value: unknown) => {
  try { return JSON.stringify(value); } catch { return String(value); }
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function mongoReference(value: unknown): MongoReference | undefined {
  const document = record(value);
  if (!document) return undefined;
  if (typeof document.$oid === "string") return { id: document.$oid };
  const id = record(document.$id);
  if (typeof document.$ref === "string" && typeof id?.$oid === "string") return {
    id: id.$oid,
    collection: document.$ref,
    ...(typeof document.$db === "string" ? { database: document.$db } : {}),
  };
  return undefined;
}

export function formatMongoValue(value: unknown): MongoValueFormat | undefined {
  const document = record(value);
  if (!document) return undefined;

  const reference = mongoReference(value);
  if (reference?.collection) return { tag: "$ref", text: `${reference.collection} → ${reference.id}`, title: exact(value), tone: "id" };

  if (typeof document.$oid === "string") return { tag: "$oid", text: document.$oid, title: document.$oid, tone: "id" };

  if (document.$date !== undefined) {
    const dateDocument = record(document.$date);
    const raw = dateDocument?.$numberLong ?? document.$date;
    const date = typeof raw === "number" || (typeof raw === "string" && /^-?\d+$/.test(raw))
      ? new Date(Number(raw))
      : new Date(String(raw));
    const valid = !Number.isNaN(date.getTime());
    return { tag: "$date", text: valid ? dateFormat.format(date) : exact(raw), title: valid ? date.toISOString() : exact(document.$date), tone: "date" };
  }

  for (const tag of ["$numberLong", "$numberDecimal", "$numberInt", "$numberDouble"] as const) {
    if (document[tag] !== undefined) return { tag, text: String(document[tag]), title: exact(document[tag]), tone: "number" };
  }

  const binary = record(document.$binary);
  if (binary && typeof binary.base64 === "string") {
    const preview = binary.base64.length > 28 ? `${binary.base64.slice(0, 28)}…` : binary.base64;
    const subtype = typeof binary.subType === "string" ? ` · subtype ${binary.subType}` : "";
    return { tag: "$binary", text: `${preview}${subtype}`, title: exact(document.$binary), tone: "binary" };
  }

  const expression = record(document.$regularExpression);
  if (expression && typeof expression.pattern === "string") {
    return { tag: "$regex", text: `/${expression.pattern}/${typeof expression.options === "string" ? expression.options : ""}`, title: exact(document.$regularExpression), tone: "pattern" };
  }

  const timestamp = record(document.$timestamp);
  if (timestamp && timestamp.t !== undefined) return { tag: "$timestamp", text: `${timestamp.t}:${timestamp.i ?? 0}`, title: exact(document.$timestamp), tone: "date" };
  if (typeof document.$code === "string") return { tag: "$code", text: document.$code, title: document.$code, tone: "code" };

  return undefined;
}
