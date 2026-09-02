import type { DataColumn, DatabaseKind, ExploreFilter, ExploreSort } from "@orbit/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { buildExploreQueryPreview } from "../lib/explore-query-preview";

type Panel = "filter" | "sort" | "query";
export type FilterValueType = "auto" | "string" | "number" | "boolean" | "objectId" | "date" | "json";

const operatorLabels: Record<ExploreFilter["operator"], string> = {
  eq: "Equals",
  neq: "Does not equal",
  contains: "Contains",
  gt: "Greater than",
  lt: "Less than",
};

export function parseFilterValue(raw: string, column: DataColumn | undefined, mongo: boolean, operator: ExploreFilter["operator"] = "eq", valueType: FilterValueType = "auto"): unknown {
  const value = raw.trim();
  const nativeType = column?.nativeType.toLowerCase();
  if (!value) throw new Error("Enter a filter value.");
  if (operator === "contains") {
    if (mongo && nativeType && nativeType !== "string") throw new Error("Contains is only available for MongoDB string fields.");
    return value;
  }
  if (mongo && valueType === "string") return value;
  if (/^null$/i.test(value)) return null;
  if (mongo && valueType === "json") {
    try { return JSON.parse(value); } catch { throw new Error("Enter valid JSON."); }
  }
  if (mongo && valueType === "objectId") {
    if (!/^[a-f\d]{24}$/i.test(value)) throw new Error("ObjectId values must contain exactly 24 hexadecimal characters.");
    return { $oid: value };
  }
  if (mongo && valueType === "date") {
    if (Number.isNaN(Date.parse(value))) throw new Error("Enter a valid ISO date, for example 2026-09-02T12:00:00Z.");
    return { $date: value };
  }
  if (mongo && valueType === "boolean") {
    if (!/^(true|false)$/i.test(value)) throw new Error("Boolean values must be true or false.");
    return JSON.parse(value.toLowerCase());
  }
  if (mongo && valueType === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Enter a valid number.");
    return number;
  }
  if (mongo && ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]")))) {
    try { return JSON.parse(value); } catch { throw new Error("Enter valid JSON or a plain value."); }
  }
  if (mongo && nativeType === "objectid") {
    if (!/^[a-f\d]{24}$/i.test(value)) throw new Error("ObjectId values must contain exactly 24 hexadecimal characters.");
    return { $oid: value };
  }
  if (mongo && nativeType === "date") {
    if (Number.isNaN(Date.parse(value))) throw new Error("Enter a valid ISO date, for example 2026-09-02T12:00:00Z.");
    return { $date: value };
  }
  if (mongo && nativeType === "int64") {
    if (!/^-?\d+$/.test(value)) throw new Error("Int64 values must be whole numbers.");
    return { $numberLong: value };
  }
  if (mongo && nativeType === "decimal128") {
    if (!/^(?:[-+]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|infinity)|nan)$/i.test(value)) throw new Error("Enter a valid Decimal128 number.");
    return { $numberDecimal: value };
  }
  if (mongo && nativeType === "string") return value;
  if (mongo && nativeType === "boolean") {
    if (!/^(true|false)$/i.test(value)) throw new Error("Boolean values must be true or false.");
    return JSON.parse(value.toLowerCase());
  }
  if (mongo && nativeType === "int32") {
    if (!/^-?\d+$/.test(value) || Number(value) < -2_147_483_648 || Number(value) > 2_147_483_647) throw new Error("Enter a valid 32-bit whole number.");
    return Number(value);
  }
  if (mongo && (nativeType === "double" || nativeType === "number")) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Enter a valid number.");
    return number;
  }
  if (mongo) return value;
  if (!mongo && (column?.enumValues?.length || /(?:char|string|text|uuid|citext|inet)/i.test(nativeType ?? ""))) return value;
  if (/^(true|false)$/i.test(value)) return JSON.parse(value.toLowerCase());
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try { return JSON.parse(value); } catch { throw new Error("Enter valid JSON or a plain value."); }
  }
  return value;
}

const valueLabel = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

export function ExploreQueryControls({ columns, filters, sort, databaseKind, namespace, object, offset = 0, onFiltersChange, onSortChange }: {
  columns: DataColumn[];
  filters: ExploreFilter[];
  sort: ExploreSort[];
  databaseKind: DatabaseKind;
  namespace: string;
  object: string;
  offset?: number;
  onFiltersChange: (filters: ExploreFilter[]) => void;
  onSortChange: (sort: ExploreSort[]) => void;
}) {
  const mongo = databaseKind === "mongodb";
  const [panel, setPanel] = useState<Panel>();
  const controlsRef = useRef<HTMLDivElement>(null);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<ExploreFilter["operator"]>("eq");
  const [filterValue, setFilterValue] = useState("");
  const [filterValueType, setFilterValueType] = useState<FilterValueType>("auto");
  const [filterError, setFilterError] = useState("");
  const [queryCopied, setQueryCopied] = useState(false);
  const [sortColumn, setSortColumn] = useState("");
  const [sortDirection, setSortDirection] = useState<ExploreSort["direction"]>("asc");
  const listId = useId();

  const selectedFilterColumn = filterColumn || columns[0]?.name || "";
  const selectedSortColumn = sortColumn || columns[0]?.name || "";
  const queryPreview = buildExploreQueryPreview({ databaseKind, namespace, object, filters, sort, limit: 50, offset });

  useEffect(() => {
    if (!panel) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlsRef.current?.contains(event.target)) setPanel(undefined);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(undefined);
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [panel]);

  function addFilter(event: FormEvent) {
    event.preventDefault();
    if (!selectedFilterColumn || !filterValue.trim().length || filters.length >= 20) return;
    const column = columns.find((item) => item.name === selectedFilterColumn);
    try {
      const value = parseFilterValue(filterValue, column, mongo, filterOperator, filterValueType);
      onFiltersChange([...filters, { column: selectedFilterColumn, operator: filterOperator, value }]);
      setFilterValue(""); setFilterError("");
    } catch (reason) {
      setFilterError(reason instanceof Error ? reason.message : "This filter value is invalid.");
    }
  }

  async function copyQuery() {
    await navigator.clipboard.writeText(queryPreview.query);
    setQueryCopied(true); window.setTimeout(() => setQueryCopied(false), 1600);
  }

  function addSort(event: FormEvent) {
    event.preventDefault();
    if (!selectedSortColumn || sort.length >= 5) return;
    onSortChange([...sort.filter((item) => item.column !== selectedSortColumn), { column: selectedSortColumn, direction: sortDirection }]);
  }

  return <div className="explore-query-controls" ref={controlsRef}>
    <button className={filters.length ? "active" : ""} type="button" aria-expanded={panel === "filter"} onClick={() => setPanel(panel === "filter" ? undefined : "filter")}><span>⌁</span> Filter{filters.length ? <b>{filters.length}</b> : null}</button>
    <button className={sort.length ? "active" : ""} type="button" aria-expanded={panel === "sort"} onClick={() => setPanel(panel === "sort" ? undefined : "sort")}><span>⇅</span> Sort{sort.length ? <b>{sort.length}</b> : null}</button>
    <button type="button" aria-expanded={panel === "query"} onClick={() => setPanel(panel === "query" ? undefined : "query")}><span>{"</>"}</span> Query</button>
    <datalist id={listId}>{columns.map((column) => <option value={column.name} key={column.name} />)}</datalist>
    {panel === "filter" && <section className="query-control-popover" aria-label="Document filters"><header><div><strong>Filter documents</strong><small>All conditions are combined with AND.</small></div><button type="button" onClick={() => setPanel(undefined)}>×</button></header>{filters.length > 0 && <div className="query-rules">{filters.map((filter, index) => <div className="query-rule" key={`${filter.column}-${index}`}><code>{filter.column}</code><span>{operatorLabels[filter.operator]}</span><strong title={valueLabel(filter.value)}>{valueLabel(filter.value)}</strong><button type="button" aria-label={`Remove filter on ${filter.column}`} onClick={() => onFiltersChange(filters.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}<button className="clear-rules" type="button" onClick={() => onFiltersChange([])}>Clear all</button></div>}<form onSubmit={addFilter}><label>Field<input list={listId} required value={selectedFilterColumn} placeholder="field.name" onChange={(event) => { setFilterColumn(event.target.value); setFilterValueType("auto"); setFilterError(""); }} /></label><label>Condition<select value={filterOperator} onChange={(event) => { setFilterOperator(event.target.value as ExploreFilter["operator"]); setFilterError(""); }}>{Object.entries(operatorLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="query-value-field"><span>Value{mongo && filterOperator !== "contains" && <select aria-label="Value type" value={filterValueType} onChange={(event) => { setFilterValueType(event.target.value as FilterValueType); setFilterError(""); }}><option value="auto">Auto · {columns.find((item) => item.name === selectedFilterColumn)?.nativeType ?? "String"}</option><option value="string">String</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="objectId">ObjectId</option><option value="date">Date</option><option value="json">JSON</option></select>}</span><input required value={filterValue} placeholder={mongo ? filterOperator === "contains" ? "literal text to find" : "value, JSON, ObjectId, or ISO date" : "value"} onChange={(event) => { setFilterValue(event.target.value); setFilterError(""); }} /></label><button className="primary" disabled={!selectedFilterColumn || !filterValue.trim().length || filters.length >= 20}>Add filter</button></form>{filterError && <p className="query-filter-error" role="alert">{filterError}</p>}</section>}
    {panel === "sort" && <section className="query-control-popover sort-popover" aria-label="Document sorting"><header><div><strong>Sort documents</strong><small>Rules run in the order shown.</small></div><button type="button" onClick={() => setPanel(undefined)}>×</button></header>{sort.length > 0 && <div className="query-rules">{sort.map((item, index) => <div className="query-rule" key={item.column}><code>{index + 1}. {item.column}</code><span>{item.direction === "asc" ? "Ascending" : "Descending"}</span><button type="button" aria-label={`Remove sort on ${item.column}`} onClick={() => onSortChange(sort.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}<button className="clear-rules" type="button" onClick={() => onSortChange([])}>Clear all</button></div>}<form onSubmit={addSort}><label>Field<input list={listId} required value={selectedSortColumn} placeholder="field.name" onChange={(event) => setSortColumn(event.target.value)} /></label><label>Direction<select value={sortDirection} onChange={(event) => setSortDirection(event.target.value as ExploreSort["direction"])}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label><button className="primary" disabled={!selectedSortColumn || sort.length >= 5}>Add sort</button></form></section>}
    {panel === "query" && <section className="query-control-popover query-preview-popover" aria-label="Generated query"><header><div><strong>{queryPreview.label}</strong><small>Generated from the current filters and sort · read-only</small></div><button type="button" onClick={() => setPanel(undefined)}>×</button></header><pre>{queryPreview.query}</pre><footer><span>{mongo ? "Extended JSON values are converted to native BSON before execution." : "Values are sent separately as bound parameters."}</span><button type="button" onClick={() => void copyQuery()}>{queryCopied ? "Copied" : "Copy query"}</button></footer></section>}
  </div>;
}
