import type { DatabaseKind, ExploreFilter, ExploreSort } from "@orbit/contracts";

const mongoOperator = { eq: "$eq", neq: "$ne", gt: "$gt", lt: "$lt" } as const;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mongoShellLiteral(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return value.length ? `[\n${value.map((item) => `${"  ".repeat(depth + 1)}${mongoShellLiteral(item, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}]` : "[]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length === 1) {
      if (typeof record.$oid === "string") return `ObjectId(${JSON.stringify(record.$oid)})`;
      if (typeof record.$date === "string") return `ISODate(${JSON.stringify(record.$date)})`;
      if (typeof record.$numberLong === "string") return `NumberLong(${JSON.stringify(record.$numberLong)})`;
      if (typeof record.$numberDecimal === "string") return `NumberDecimal(${JSON.stringify(record.$numberDecimal)})`;
    }
    return entries.length ? `{\n${entries.map(([key, item]) => `${"  ".repeat(depth + 1)}${JSON.stringify(key)}: ${mongoShellLiteral(item, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}}` : "{}";
  }
  return "null";
}

export function mongoFilterPreview(filters: ExploreFilter[]): Record<string, unknown> {
  if (!filters.length) return {};
  return {
    $and: filters.map((filter) => ({
      [filter.column]: filter.operator === "contains"
        ? { $regex: escapeRegex(String(filter.value)), $options: "i" }
        : { [mongoOperator[filter.operator]]: filter.value },
    })),
  };
}

const quoteIdentifier = (value: string, quote: '"' | "`") => `${quote}${value.replaceAll(quote, quote + quote)}${quote}`;

export function buildExploreQueryPreview({ databaseKind, namespace, object, filters, sort, limit, offset }: {
  databaseKind: DatabaseKind;
  namespace: string;
  object: string;
  filters: ExploreFilter[];
  sort: ExploreSort[];
  limit: number;
  offset: number;
}): { label: string; query: string } {
  if (databaseKind === "mongodb") {
    const filter = mongoShellLiteral(mongoFilterPreview(filters));
    const sorting = mongoShellLiteral(Object.fromEntries(sort.map((item) => [item.column, item.direction === "asc" ? 1 : -1])));
    return {
      label: "MongoDB driver operation",
      query: `db.getSiblingDB(${JSON.stringify(namespace)})\n  .getCollection(${JSON.stringify(object)})\n  .find(${filter})\n  .sort(${sorting})\n  .skip(${offset})\n  .limit(${limit + 1})`,
    };
  }

  const quote = databaseKind === "mysql" ? "`" : '"';
  const placeholders = filters.map((_, index) => databaseKind === "postgres" ? `$${index + 1}` : "?");
  const where = filters.map((filter, index) => {
    const operator = { eq: "=", neq: "<>", gt: ">", lt: "<", contains: databaseKind === "postgres" ? "::text ILIKE" : "LIKE" }[filter.operator];
    return `${quoteIdentifier(filter.column, quote)} ${operator} ${placeholders[index]}`;
  });
  const order = sort.map((item) => `${quoteIdentifier(item.column, quote)} ${item.direction.toUpperCase()}`);
  const parameterValues = filters.map((filter) => filter.operator === "contains" ? `%${String(filter.value)}%` : filter.value);
  const parameterComment = parameterValues.length ? `\n\n-- Bound parameters: ${JSON.stringify(parameterValues)}` : "";
  return {
    label: databaseKind === "postgres" ? "PostgreSQL query" : "MySQL query",
    query: `SELECT *\nFROM ${quoteIdentifier(namespace, quote)}.${quoteIdentifier(object, quote)}${where.length ? `\nWHERE ${where.join("\n  AND ")}` : ""}${order.length ? `\nORDER BY ${order.join(", ")}` : ""}\nLIMIT ${limit + 1} OFFSET ${offset};${parameterComment}`,
  };
}
