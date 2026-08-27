import type { DataColumn } from "@orbit/contracts";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Visualization = { kind: "line" | "bar" | "donut" | "table"; x?: string | undefined; y?: string[] | undefined };
type ChartKind = Exclude<Visualization["kind"], "table">;
type ChartSeries = { key: string; name: string; color: string };
export type PreparedChart =
  | { valid: false; reason: string }
  | { valid: true; kind: ChartKind; data: Record<string, string | number | null>[]; xName: string; series: ChartSeries[]; inferred: boolean; truncated: boolean };

const colors = ["#7d86e8", "#61aa84", "#d39755", "#bd78aa"];
const numericTypePattern = /(?:^|\b)(?:tinyint|smallint|mediumint|bigint|int\d*|integer|float|double|decimal|numeric|number|real|serial|money|long)(?:\b|$)/i;
const extendedNumberKeys = ["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"] as const;

export function numericChartValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
  if (typeof value === "string" && value.trim() && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())) { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of extendedNumberKeys) if (key in value) return numericChartValue((value as Record<string, unknown>)[key]);
  }
  return undefined;
}

function chartLabel(value: unknown, index: number): string {
  if (value === null || value === undefined) return `Row ${index + 1}`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "object" && !Array.isArray(value) && "$date" in value) return String((value as Record<string, unknown>).$date);
  try { return JSON.stringify(value); } catch { return `Row ${index + 1}`; }
}

function hasNumericValues(rows: Record<string, unknown>[], name: string) { return rows.some((row) => numericChartValue(row[name]) !== undefined); }

export function prepareChartData(columns: DataColumn[], rows: Record<string, unknown>[], visualization: Visualization, compact = false): PreparedChart {
  if (visualization.kind === "table") return { valid: false, reason: "The answer is configured as a table." };
  if (!rows.length) return { valid: false, reason: "The query returned no rows to chart." };
  const names = new Set(columns.map((column) => column.name));
  const numericColumns = columns.filter((column) => numericTypePattern.test(column.nativeType) || hasNumericValues(rows, column.name)).filter((column) => hasNumericValues(rows, column.name));
  const requestedY = (visualization.y ?? []).filter((name) => names.has(name));
  let yNames = requestedY.filter((name) => hasNumericValues(rows, name));
  let inferred = yNames.length !== requestedY.length || requestedY.length === 0;
  if (!yNames.length) yNames = numericColumns.map((column) => column.name);
  yNames = yNames.slice(0, visualization.kind === "donut" ? 1 : 4);
  if (!yNames.length) return { valid: false, reason: "A chart needs at least one numeric result column. Showing the evidence table instead." };
  const requestedX = visualization.x && names.has(visualization.x) && !yNames.includes(visualization.x) ? visualization.x : undefined;
  const inferredX = columns.find((column) => !yNames.includes(column.name) && !numericColumns.some((numeric) => numeric.name === column.name))?.name ?? columns.find((column) => !yNames.includes(column.name))?.name;
  const xName = requestedX ?? inferredX ?? "Row";
  if (!requestedX) inferred = inferred || Boolean(visualization.x) || !visualization.x;
  const series = yNames.map((name, index) => ({ key: `orbitValue${index}`, name, color: colors[index % colors.length]! }));
  const converted = rows.map((row, index) => {
    const point: Record<string, string | number | null> = { orbitLabel: chartLabel(requestedX || inferredX ? row[xName] : undefined, index) };
    series.forEach((item) => { point[item.key] = numericChartValue(row[item.name]) ?? null; });
    return point;
  }).filter((point) => { const donutValue = point[series[0]!.key]; return visualization.kind === "donut" ? typeof donutValue === "number" && donutValue > 0 : series.some((item) => typeof point[item.key] === "number"); });
  if (!converted.length) return { valid: false, reason: visualization.kind === "donut" ? "A donut chart needs positive numeric values. Showing the evidence table instead." : "No finite numeric values were returned. Showing the evidence table instead." };
  const limit = visualization.kind === "donut" ? compact ? 8 : 12 : compact ? 16 : 40;
  return { valid: true, kind: visualization.kind, data: converted.slice(0, limit), xName, series, inferred, truncated: converted.length > limit };
}

const formatNumber = (value: number) => new Intl.NumberFormat(undefined, { notation: Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 2 }).format(value);
const tooltipStyle = { background: "var(--orbit-surface-raised)", border: "1px solid var(--orbit-border-strong)", borderRadius: 8, color: "var(--orbit-text)", boxShadow: "0 10px 35px var(--orbit-shadow)", fontSize: 11 };

export type ResultChartProps = { columns: DataColumn[]; rows: Record<string, unknown>[]; visualization: Visualization; compact?: boolean };

export function ResultChart({ columns, rows, visualization, compact = false }: ResultChartProps) {
  const chart = prepareChartData(columns, rows, visualization, compact);
  if (!chart.valid) return <div className={`chart-fallback${compact ? " compact" : ""}`}><span>▥</span><p>{chart.reason}</p></div>;
  const yLabel = chart.series.map((series) => series.name).join(", ");
  const common = <>
    <CartesianGrid stroke="var(--orbit-border)" strokeDasharray="3 4" vertical={false} />
    <XAxis dataKey="orbitLabel" stroke="var(--orbit-text-muted)" tickLine={false} axisLine={{ stroke: "var(--orbit-border-strong)" }} tick={{ fill: "var(--orbit-text-muted)", fontSize: compact ? 8 : 10 }} minTickGap={14} height={compact ? 24 : 48} {...(!compact ? { label: { value: chart.xName, position: "insideBottom", offset: 0, fill: "var(--orbit-text-muted)", fontSize: 9 } } : {})} />
    <YAxis stroke="var(--orbit-text-muted)" tickLine={false} axisLine={false} width={compact ? 34 : 58} tick={{ fill: "var(--orbit-text-muted)", fontSize: compact ? 8 : 10 }} tickFormatter={(value: number) => formatNumber(value)} {...(!compact ? { label: { value: yLabel, angle: -90, position: "insideLeft", fill: "var(--orbit-text-muted)", fontSize: 9 } } : {})} />
    <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--orbit-text-soft)", marginBottom: 4 }} formatter={(value) => formatNumber(Number(value))} labelFormatter={(label) => `${chart.xName}: ${String(label)}`} />
    {chart.series.length > 1 && !compact && <Legend wrapperStyle={{ color: "var(--orbit-text-muted)", fontSize: 10, paddingTop: 8 }} />}
  </>;
  return <section className={`data-chart ${chart.kind}${compact ? " compact" : ""}`} aria-label={`${chart.kind} chart of ${yLabel} by ${chart.xName}`}>
    {!compact && <header><div><strong>{chart.kind === "donut" ? "Donut" : chart.kind === "line" ? "Line" : "Bar"} chart</strong><small>{yLabel} by {chart.xName}</small></div>{chart.inferred && <span>Fields inferred</span>}</header>}
    <div className="chart-canvas"><ResponsiveContainer width="100%" height="100%">
      {chart.kind === "bar" ? <BarChart data={chart.data} margin={compact ? { top: 8, right: 6, bottom: 0, left: 0 } : { top: 16, right: 20, bottom: 4, left: 10 }}>{common}{chart.series.map((series) => <Bar key={series.key} dataKey={series.key} name={series.name} fill={series.color} radius={[4, 4, 0, 0]} maxBarSize={48} />)}</BarChart>
        : chart.kind === "line" ? <LineChart data={chart.data} margin={compact ? { top: 8, right: 8, bottom: 0, left: 0 } : { top: 16, right: 22, bottom: 4, left: 10 }}>{common}{chart.series.map((series) => <Line key={series.key} type="monotone" dataKey={series.key} name={series.name} stroke={series.color} strokeWidth={compact ? 1.5 : 2.25} dot={compact ? false : { r: 2.5 }} activeDot={{ r: 4 }} connectNulls />)}</LineChart>
        : <PieChart><Tooltip contentStyle={tooltipStyle} formatter={(value) => formatNumber(Number(value))} /><Pie data={chart.data} dataKey={chart.series[0]!.key} nameKey="orbitLabel" innerRadius="52%" outerRadius="78%" paddingAngle={2} stroke="var(--orbit-surface)">{chart.data.map((_, index) => <Cell key={index} fill={colors[index % colors.length]!} />)}</Pie>{!compact && <Legend wrapperStyle={{ color: "var(--orbit-text-muted)", fontSize: 10 }} />}</PieChart>}
    </ResponsiveContainer></div>
    {!compact && chart.truncated && <footer>Showing the first {chart.data.length} chartable rows. The evidence table contains the full bounded result.</footer>}
  </section>;
}
