import type { DataColumn, ExploreFilter, ExploreSort } from "@orbit/contracts";
import { type FormEvent, useId, useState } from "react";

type Panel = "filter" | "sort";

const operatorLabels: Record<ExploreFilter["operator"], string> = {
  eq: "Equals",
  neq: "Does not equal",
  contains: "Contains",
  gt: "Greater than",
  lt: "Less than",
};

export function parseFilterValue(raw: string, column: DataColumn | undefined, mongo: boolean): unknown {
  const value = raw.trim();
  const nativeType = column?.nativeType.toLowerCase();
  if (mongo && nativeType === "objectid" && /^[a-f\d]{24}$/i.test(value)) return { $oid: value };
  if (mongo && nativeType === "date") return { $date: value };
  if (mongo && nativeType === "int64" && /^-?\d+$/.test(value)) return { $numberLong: value };
  if (mongo && nativeType === "decimal128") return { $numberDecimal: value };
  if (/^(true|false|null)$/i.test(value)) return JSON.parse(value.toLowerCase());
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try { return JSON.parse(value); } catch { return raw; }
  }
  return raw;
}

const valueLabel = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

export function ExploreQueryControls({ columns, filters, sort, mongo, onFiltersChange, onSortChange }: {
  columns: DataColumn[];
  filters: ExploreFilter[];
  sort: ExploreSort[];
  mongo: boolean;
  onFiltersChange: (filters: ExploreFilter[]) => void;
  onSortChange: (sort: ExploreSort[]) => void;
}) {
  const [panel, setPanel] = useState<Panel>();
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<ExploreFilter["operator"]>("eq");
  const [filterValue, setFilterValue] = useState("");
  const [sortColumn, setSortColumn] = useState("");
  const [sortDirection, setSortDirection] = useState<ExploreSort["direction"]>("asc");
  const listId = useId();

  const selectedFilterColumn = filterColumn || columns[0]?.name || "";
  const selectedSortColumn = sortColumn || columns[0]?.name || "";

  function addFilter(event: FormEvent) {
    event.preventDefault();
    if (!selectedFilterColumn || !filterValue.length || filters.length >= 20) return;
    const column = columns.find((item) => item.name === selectedFilterColumn);
    onFiltersChange([...filters, { column: selectedFilterColumn, operator: filterOperator, value: parseFilterValue(filterValue, column, mongo) }]);
    setFilterValue("");
  }

  function addSort(event: FormEvent) {
    event.preventDefault();
    if (!selectedSortColumn || sort.length >= 5) return;
    onSortChange([...sort.filter((item) => item.column !== selectedSortColumn), { column: selectedSortColumn, direction: sortDirection }]);
  }

  return <div className="explore-query-controls">
    <button className={filters.length ? "active" : ""} type="button" aria-expanded={panel === "filter"} onClick={() => setPanel(panel === "filter" ? undefined : "filter")}><span>⌁</span> Filter{filters.length ? <b>{filters.length}</b> : null}</button>
    <button className={sort.length ? "active" : ""} type="button" aria-expanded={panel === "sort"} onClick={() => setPanel(panel === "sort" ? undefined : "sort")}><span>⇅</span> Sort{sort.length ? <b>{sort.length}</b> : null}</button>
    <datalist id={listId}>{columns.map((column) => <option value={column.name} key={column.name} />)}</datalist>
    {panel === "filter" && <section className="query-control-popover" aria-label="Document filters"><header><div><strong>Filter documents</strong><small>All conditions are combined with AND.</small></div><button type="button" onClick={() => setPanel(undefined)}>×</button></header>{filters.length > 0 && <div className="query-rules">{filters.map((filter, index) => <div className="query-rule" key={`${filter.column}-${index}`}><code>{filter.column}</code><span>{operatorLabels[filter.operator]}</span><strong title={valueLabel(filter.value)}>{valueLabel(filter.value)}</strong><button type="button" aria-label={`Remove filter on ${filter.column}`} onClick={() => onFiltersChange(filters.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}<button className="clear-rules" type="button" onClick={() => onFiltersChange([])}>Clear all</button></div>}<form onSubmit={addFilter}><label>Field<input list={listId} required value={selectedFilterColumn} placeholder="field.name" onChange={(event) => setFilterColumn(event.target.value)} /></label><label>Condition<select value={filterOperator} onChange={(event) => setFilterOperator(event.target.value as ExploreFilter["operator"])}>{Object.entries(operatorLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="query-value-field">Value<input required value={filterValue} placeholder={mongo ? "value, JSON, ObjectId, or ISO date" : "value"} onChange={(event) => setFilterValue(event.target.value)} /></label><button className="primary" disabled={!selectedFilterColumn || !filterValue.length || filters.length >= 20}>Add filter</button></form></section>}
    {panel === "sort" && <section className="query-control-popover sort-popover" aria-label="Document sorting"><header><div><strong>Sort documents</strong><small>Rules run in the order shown.</small></div><button type="button" onClick={() => setPanel(undefined)}>×</button></header>{sort.length > 0 && <div className="query-rules">{sort.map((item, index) => <div className="query-rule" key={item.column}><code>{index + 1}. {item.column}</code><span>{item.direction === "asc" ? "Ascending" : "Descending"}</span><button type="button" aria-label={`Remove sort on ${item.column}`} onClick={() => onSortChange(sort.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}<button className="clear-rules" type="button" onClick={() => onSortChange([])}>Clear all</button></div>}<form onSubmit={addSort}><label>Field<input list={listId} required value={selectedSortColumn} placeholder="field.name" onChange={(event) => setSortColumn(event.target.value)} /></label><label>Direction<select value={sortDirection} onChange={(event) => setSortDirection(event.target.value as ExploreSort["direction"])}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label><button className="primary" disabled={!selectedSortColumn || sort.length >= 5}>Add sort</button></form></section>}
  </div>;
}
