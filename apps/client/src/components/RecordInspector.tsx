import type { DataColumn, LinkedDocument, ReferenceLookupRequest, ReferenceLookupResult } from "@orbit/contracts";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { DataValue } from "./DataValue";

const INSPECTOR_WIDTH_KEY = "orbit:record-inspector-width";
const DEFAULT_INSPECTOR_WIDTH = 430;

export function clampInspectorWidth(width: number, viewportWidth: number): number {
  const maximum = Math.max(280, Math.min(960, viewportWidth - 80));
  const minimum = Math.min(320, maximum);
  return Math.round(Math.min(maximum, Math.max(minimum, width)));
}

function initialInspectorWidth(): number {
  if (typeof window === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  try { return clampInspectorWidth(Number(window.localStorage.getItem(INSPECTOR_WIDTH_KEY)) || DEFAULT_INSPECTOR_WIDTH, window.innerWidth); }
  catch { return clampInspectorWidth(DEFAULT_INSPECTOR_WIDTH, window.innerWidth); }
}

export interface ReferenceLookupState {
  context: ReferenceLookupRequest;
  loading: boolean;
  result?: ReferenceLookupResult;
  error?: string;
}

export function RecordInspector({ baseDocument, baseDatabase, baseCollection, columns = [], trail, lookup, mongo, postgres = false, onResolve, onSearchAll, onChoose, onBack, onClose }: {
  baseDocument: Record<string, unknown>;
  baseDatabase: string;
  baseCollection: string;
  columns?: DataColumn[];
  trail: LinkedDocument[];
  lookup?: ReferenceLookupState | undefined;
  mongo: boolean;
  postgres?: boolean;
  onResolve: (database: string, collection: string, field: string, value: unknown, reference?: DataColumn["reference"]) => void;
  onSearchAll: () => void;
  onChoose: (document: LinkedDocument) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [configuredWidth, setConfiguredWidth] = useState(initialInspectorWidth);
  const [expanded, setExpanded] = useState(false);
  const [resizing, setResizing] = useState(false);
  const resizeOrigin = useRef<{ x: number; width: number } | undefined>(undefined);
  const linked = trail.at(-1);
  const database = linked?.database ?? baseDatabase;
  const collection = linked?.collection ?? baseCollection;
  const document = linked?.document ?? baseDocument;
  const documentColumns = linked?.columns ?? columns;
  const postgresLookup = Boolean(lookup?.context.reference);

  useEffect(() => {
    const fitToViewport = () => setConfiguredWidth((current) => clampInspectorWidth(current, window.innerWidth));
    window.addEventListener("resize", fitToViewport);
    return () => window.removeEventListener("resize", fitToViewport);
  }, []);

  function saveWidth(width: number) {
    setConfiguredWidth(width);
    try { window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(width)); } catch { /* persistence is optional */ }
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeOrigin.current = { x: event.clientX, width: configuredWidth };
    setResizing(true);
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const origin = resizeOrigin.current;
    if (!origin) return;
    setConfiguredWidth(clampInspectorWidth(origin.width + origin.x - event.clientX, window.innerWidth));
  }

  function finishResize(event: PointerEvent<HTMLDivElement>) {
    const origin = resizeOrigin.current;
    if (!origin) return;
    const width = clampInspectorWidth(origin.width + origin.x - event.clientX, window.innerWidth);
    event.currentTarget.releasePointerCapture(event.pointerId);
    resizeOrigin.current = undefined;
    setResizing(false);
    saveWidth(width);
  }

  function cancelResize() {
    resizeOrigin.current = undefined;
    setResizing(false);
    saveWidth(configuredWidth);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    saveWidth(clampInspectorWidth(configuredWidth + delta, window.innerWidth));
  }

  const inspectorStyle = { "--inspector-width": `${configuredWidth}px` } as CSSProperties;
  const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
  return <div className={`drawer-backdrop${expanded ? " expanded" : ""}${resizing ? " resizing" : ""}`} style={inspectorStyle} onClick={onClose}><aside className="row-drawer" onClick={(event) => event.stopPropagation()} aria-label="Record inspector">
    {!expanded && <div className="drawer-resize-handle" role="separator" tabIndex={0} aria-label="Resize record inspector" aria-orientation="vertical" aria-valuemin={Math.min(320, Math.max(280, viewportWidth - 80))} aria-valuemax={Math.max(280, Math.min(960, viewportWidth - 80))} aria-valuenow={configuredWidth} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={cancelResize} onKeyDown={resizeWithKeyboard}><i /></div>}
    <header>{trail.length > 0 && <button className="drawer-back" onClick={onBack} aria-label="Back to previous document">←</button>}<div className="drawer-heading"><small>{linked ? "LINKED DOCUMENT" : mongo ? "DOCUMENT" : "ROW"}</small><h2>{collection}</h2><p>{database}.{collection}{trail.length ? ` · ${trail.length} link${trail.length === 1 ? "" : "s"} deep` : ""}</p></div><div className="drawer-actions"><button className="drawer-size-toggle" onClick={() => setExpanded((current) => !current)} aria-label={expanded ? "Restore configured inspector width" : "Expand inspector over the full table"} title={expanded ? `Restore ${configuredWidth}px width` : "Cover the full table view"}>{expanded ? "↘" : "↔"}</button><button onClick={onClose} aria-label="Close inspector" title="Close">×</button></div></header>
    <div className="record-inspector-scroll"><div className="record-inspector-content">
      {trail.length > 0 && <nav className="reference-breadcrumb" aria-label="Linked document path"><span>{baseCollection}</span>{trail.map((item, index) => <span key={`${item.collection}-${index}`}>{item.collection}</span>)}</nav>}
      {lookup?.loading && <div className="reference-status"><span className="spinner" /><strong>{postgresLookup ? "Fetching referenced row…" : "Finding linked document…"}</strong><p>{postgresLookup ? `Looking up ${lookup?.context.reference?.namespace}.${lookup?.context.reference?.object}.${lookup?.context.reference?.column}.` : "Checking the inferred collection by ObjectId."}</p></div>}
      {lookup?.error && <div className="reference-status error"><strong>Lookup failed</strong><p>{lookup.error}</p>{!postgresLookup && !lookup.context.searchAll && <button onClick={onSearchAll}>Search all collections</button>}</div>}
      {lookup?.result && !lookup.loading && !lookup.error && lookup.result.matches.length === 0 && <div className="reference-status"><strong>No linked {postgresLookup ? "row" : "document"} found</strong><p>{lookup.result.inferredCollections.length ? `Checked ${lookup.result.inferredCollections.join(", ")}.` : "No conventional collection name matched this field."}</p>{lookup.result.searchAllAvailable && <button onClick={onSearchAll}>Search all collections</button>}</div>}
      {lookup?.result && lookup.result.matches.length > 1 && <div className="reference-matches"><header><strong>Choose linked document</strong><small>{lookup.result.matches.length} collections contain this ObjectId</small></header>{lookup.result.matches.map((item) => <button key={`${item.database}.${item.collection}`} onClick={() => onChoose(item)}><span>◎</span><span><strong>{item.collection}</strong><small>{item.database}</small></span><b>Open →</b></button>)}</div>}
      {!lookup?.loading && !(lookup?.result && lookup.result.matches.length > 1) && Object.entries(document).map(([key, value]) => { const column = documentColumns.find((item) => item.name === key); const canResolve = (mongo && key !== "_id") || (postgres && Boolean(column?.reference) && value !== null && value !== undefined); return <div className="field" key={key}><label>{key}</label><div className="field-value"><DataValue fieldName={key} nativeType={column?.nativeType} reference={column?.reference} enumValues={column?.enumValues} value={value} mongo={mongo} postgres={postgres} expanded onReference={canResolve ? () => onResolve(database, collection, key, value, column?.reference) : undefined} /></div></div>; })}
    </div></div>
  </aside></div>;
}
