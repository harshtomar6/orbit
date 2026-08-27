import { lazy, Suspense } from "react";
import type { ResultChartProps } from "./ResultChart";

const Chart = lazy(() => import("./ResultChart").then((module) => ({ default: module.ResultChart })));

export function LazyResultChart(props: ResultChartProps) {
  return <Suspense fallback={<div className={`chart-loading${props.compact ? " compact" : ""}`}><span className="spinner" /><small>Rendering chart…</small></div>}><Chart {...props} /></Suspense>;
}
