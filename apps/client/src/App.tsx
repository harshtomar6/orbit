import type { AskAgentEvent, AskDraft, AskResult, ConnectionEnvironment, ConnectionInput, DataColumn, DataObject, DatabaseConnection, DatabaseKind, DocumentCountRequest, DocumentCountResult, ExploreFilter, ExploreResult, ExploreSort, LinkedDocument, ObjectListResult, ReferenceLookupRequest, ReferenceLookupResult, SavedView, SharedViewResult } from "@orbit/contracts";
import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api } from "./lib/api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { databaseApi } from "./lib/database-api";
import { getRuntime, transportForSection, type DatabaseTransportMode } from "./lib/runtime";
import { ExploreQueryControls } from "./components/ExploreQueryControls";
import { DataValue } from "./components/DataValue";
import { RecordInspector, type ReferenceLookupState } from "./components/RecordInspector";
import { CommandPalette, type CommandItem } from "./components/CommandPalette";
import { AskWorkspace } from "./components/AskWorkspace";
import { LazyResultChart } from "./components/LazyResultChart";
import { documentCountCacheKey, freshDocumentCount, type DocumentCountCacheEntry } from "./lib/document-count-cache";
import { expandedObjectGroupsKey, objectGroupCacheKey, objectSchemaCacheKey, parseExpandedObjectGroups, parseObjectGroup, parseObjectSchema, serializeObjectGroup, serializeObjectSchema } from "./lib/object-group-cache";
import { formatCompactCount } from "./lib/format-count";
import { clampGridCell, gridCellSelected, gridRange, gridSelectionToTsv, moveGridCell, type GridCell } from "./lib/grid-selection";
import { orderPinnedColumns, pinnedColumnOffsets } from "./lib/column-pinning";
import { closeExploreTab as closeExploreTabState, cycleExploreTab, exploreTabId, openExploreTab, type ExploreTab, type ExploreTabTarget, type ExploreTabWorkspace } from "./lib/explore-tabs";

type Section = "explore" | "ask" | "views";
type DocumentCountState = { key: string; loading: boolean; result?: DocumentCountResult; error?: string };
type ExploreTabDataCacheEntry = { signature: string; result: ExploreResult; documentCount?: DocumentCountState };
type AskTraceEvent = Extract<AskAgentEvent, { type: "progress" | "activity" | "output" }>;
const params = new URLSearchParams(window.location.search);
const sharedToken = params.get("shared");
const display = (value: unknown) => value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);
const icon = (kind: DatabaseConnection["kind"]) => <img className="database-logo" src={`/database-logos/${kind === "postgres" ? "postgresql" : kind}.svg`} alt="" />;
const objectLabel = (connection: DatabaseConnection) => connection.kind === "mongodb" ? "collections" : "tables & views";
const defaultPort = (kind: DatabaseKind) => kind === "postgres" ? 5432 : kind === "mysql" ? 3306 : 27017;
const defaultConnectionString = (kind: DatabaseKind) => kind === "postgres" ? "" : "mongodb://localhost:27017";
const objectKey = (item: Pick<DataObject, "namespace" | "name">) => `${item.namespace}.${item.name}`;
const clampSidebarWidth = (width: number) => Math.min(320, Math.max(190, width));
const exploreWorkspaceSignature = (workspace: ExploreTabWorkspace) => JSON.stringify([workspace.filters, workspace.sort, workspace.cursors, workspace.hidden, workspace.pinned, workspace.rowSearch]);
const exploreDataQuerySignature = (connectionId: string, namespace: string, object: string, filters: ExploreFilter[], sort: ExploreSort[], cursor?: string) => JSON.stringify([connectionId, namespace, object, filters, sort, cursor ?? ""]);
const readRecentExploreTargets = (mode: DatabaseTransportMode): ExploreTabTarget[] => { try { const value: unknown = JSON.parse(localStorage.getItem(`orbit.exploreRecent.${mode}`) ?? "[]"); if (!Array.isArray(value)) return []; return value.filter((item): item is ExploreTabTarget => Boolean(item && typeof item === "object" && "connectionId" in item && typeof item.connectionId === "string" && "connectionName" in item && typeof item.connectionName === "string" && "databaseKind" in item && ["mongodb", "postgres", "mysql"].includes(String(item.databaseKind)) && "namespace" in item && typeof item.namespace === "string" && "object" in item && typeof item.object === "string" && "objectKind" in item && ["collection", "table", "view"].includes(String(item.objectKind)))).slice(0, 10); } catch { return []; } };
const mergeNamespaceObjects = (current: DataObject[], namespace: string, next: DataObject[]) => [...current.filter((item) => item.namespace !== namespace), ...next];
const readObjectGroupCache = (mode: DatabaseTransportMode, connectionId: string, namespace: string) => { try { return parseObjectGroup(localStorage.getItem(objectGroupCacheKey(mode, connectionId, namespace))); } catch { return undefined; } };
const writeObjectGroupCache = (mode: DatabaseTransportMode, connectionId: string, namespace: string, objects: DataObject[]) => { try { localStorage.setItem(objectGroupCacheKey(mode, connectionId, namespace), serializeObjectGroup(objects)); } catch { /* cache is optional */ } };
const readObjectSchemaCache = (mode: DatabaseTransportMode, connectionId: string) => { try { return parseObjectSchema(localStorage.getItem(objectSchemaCacheKey(mode, connectionId))); } catch { return undefined; } };
const writeObjectSchemaCache = (mode: DatabaseTransportMode, connectionId: string, response: ObjectListResult) => { try { localStorage.setItem(objectSchemaCacheKey(mode, connectionId), serializeObjectSchema({ ...(response.namespaces ? { namespaces: response.namespaces } : {}), objects: response.objects, refreshedAt: response.refreshedAt })); } catch { /* cache is optional */ } };
const readExpandedObjectGroups = (mode: DatabaseTransportMode, connectionId: string) => { try { return parseExpandedObjectGroups(localStorage.getItem(expandedObjectGroupsKey(mode, connectionId))); } catch { return []; } };
const writeExpandedObjectGroups = (mode: DatabaseTransportMode, connectionId: string, namespaces: string[]) => { try { localStorage.setItem(expandedObjectGroupsKey(mode, connectionId), JSON.stringify(namespaces)); } catch { /* cache is optional */ } };
const emptyConnection = (): ConnectionInput => ({ name: "", kind: "mongodb", environment: "development", host: "localhost", port: 27017, database: "", username: "", password: "", tls: true });
const chartPreviewColumns: DataColumn[] = [{ name: "month", nativeType: "text", nullable: false }, { name: "users", nativeType: "integer", nullable: false }, { name: "revenue", nativeType: "numeric", nullable: false }];
const chartPreviewRows = [{ month: "Jan", users: 118, revenue: 18400 }, { month: "Feb", users: 154, revenue: 23600 }, { month: "Mar", users: 142, revenue: 22100 }, { month: "Apr", users: 193, revenue: 30700 }, { month: "May", users: 226, revenue: 35800 }, { month: "Jun", users: 271, revenue: 44600 }];
type IconName = "explore" | "ask" | "views" | "database" | "chevron" | "refresh" | "columns" | "copy" | "download" | "plus" | "sun" | "moon" | "pin" | "sort" | "close";
function AppIcon({ name, size = 16 }: { name: IconName; size?: number }) { const paths: Record<IconName, ReactNode> = {
  explore: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  ask: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="m5 15 .8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15Z"/></>,
  views: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M10 10v10"/></>, database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
  chevron: <path d="m9 18 6-6-6-6"/>, refresh: <><path d="M20 6v5h-5"/><path d="M18.5 16a8 8 0 1 1 .4-8.5L20 11"/></>, columns: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></>, copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>, download: <><path d="M12 3v12m0 0 4-4m-4-4"/><path d="M5 21h14"/></>, plus: <path d="M12 5v14M5 12h14"/>, sun: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>, moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>, pin: <><path d="M9 3h6l-1 7 3 3H7l3-3-1-7Z"/><path d="M12 13v8"/></>, sort: <><path d="M7 6h10M7 12h7M7 18h4"/><path d="m17 15 3 3 3-3M20 18V6"/></>, close: <path d="m6 6 12 12M18 6 6 18"/>,
}; return <svg className="app-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }

export function App() {
  const runtime = getRuntime();
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("orbit.theme") as "light" | "dark" | null) ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  const [section, setSection] = useState<Section>("explore");
  const transportMode = transportForSection(runtime, section);
  const exploreTransport: DatabaseTransportMode = runtime === "desktop" ? "local" : "gateway";
  const dbApi = useMemo(() => databaseApi(transportMode), [transportMode]);
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [connectionId, setConnectionId] = useState(params.get("connection") ?? "");
  const [objects, setObjects] = useState<DataObject[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [objectName, setObjectName] = useState(params.get("object") ?? "");
  const [result, setResult] = useState<ExploreResult>();
  const [loading, setLoading] = useState(true); const [error, setError] = useState<ApiRequestError>();
  const [menu, setMenu] = useState(false); const [objectSearch, setObjectSearch] = useState(""); const [collapsedObjectGroups, setCollapsedObjectGroups] = useState<Set<string>>(new Set());
  const [refreshingSchema, setRefreshingSchema] = useState(false);
  const [loadingObjectGroups, setLoadingObjectGroups] = useState<Set<string>>(new Set()); const [objectGroupErrors, setObjectGroupErrors] = useState<Record<string, string>>({});
  const loadedObjectGroups = useRef<Set<string>>(new Set()); const activeConnectionId = useRef(connectionId); activeConnectionId.current = connectionId;
  const [rowSearch, setRowSearch] = useState(params.get("search") ?? "");
  const [filters, setFilters] = useState<ExploreFilter[]>([]); const [sort, setSort] = useState<ExploreSort[]>([]); const [cursors, setCursors] = useState<string[]>([]);
  const [documentCount, setDocumentCount] = useState<DocumentCountState>(); const [countRefresh, setCountRefresh] = useState(0);
  const documentCountCache = useRef<Map<string, DocumentCountCacheEntry>>(new Map()); const documentCountRequests = useRef<Map<string, Promise<DocumentCountResult>>>(new Map());
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown>>(); const [referenceTrail, setReferenceTrail] = useState<LinkedDocument[]>([]); const [referenceLookup, setReferenceLookup] = useState<ReferenceLookupState>(); const [hidden, setHidden] = useState<Set<string>>(new Set()); const [pinned, setPinned] = useState<Set<string>>(new Set()); const [pinOffsets, setPinOffsets] = useState<Record<string, number>>({});
  const headerCells = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const [gridAnchor, setGridAnchor] = useState<GridCell>({ row: 0, column: 0 }); const [gridActive, setGridActive] = useState<GridCell>({ row: 0, column: 0 }); const [gridCopyNotice, setGridCopyNotice] = useState("");
  const referenceCache = useRef<Map<string, ReferenceLookupResult>>(new Map());
  const [managing, setManaging] = useState(false); const [formOpen, setFormOpen] = useState(false); const [connectionForm, setConnectionForm] = useState<ConnectionInput>(emptyConnection());
  const [connectionString, setConnectionString] = useState(defaultConnectionString("mongodb"));
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1);
  const [editing, setEditing] = useState<DatabaseConnection>(); const [saving, setSaving] = useState(false); const [managerError, setManagerError] = useState(""); const [testingId, setTestingId] = useState("");
  const [question, setQuestion] = useState(""); const [askDraft, setAskDraft] = useState<AskDraft>(); const [askResult, setAskResult] = useState<AskResult>();
  const [askTrace, setAskTrace] = useState<AskTraceEvent[]>([]);
  const [askState, setAskState] = useState<"idle" | "generating" | "ready" | "executing" | "complete">("idle"); const [askError, setAskError] = useState<ApiRequestError>();
  const [views, setViews] = useState<SavedView[]>([]); const [viewResults, setViewResults] = useState<Record<string, ExploreResult>>({}); const [viewError, setViewError] = useState(""); const [refreshingView, setRefreshingView] = useState("");
  const [saveDialog, setSaveDialog] = useState<"explore" | "ask">(); const [saveName, setSaveName] = useState(""); const [savingView, setSavingView] = useState(false); const [sharedView, setSharedView] = useState<SharedViewResult>(); const [sharedError, setSharedError] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(Number(localStorage.getItem("orbit.sidebarWidth")) || 224));
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [exploreTabs, setExploreTabs] = useState<ExploreTab[]>([]);
  const [activeExploreTabId, setActiveExploreTabId] = useState("");
  const [exploreTabsHydrated, setExploreTabsHydrated] = useState(false);
  const [recentExploreTargets, setRecentExploreTargets] = useState<ExploreTabTarget[]>(() => readRecentExploreTargets(exploreTransport));
  const exploreTabsRef = useRef(exploreTabs); exploreTabsRef.current = exploreTabs;
  const activeExploreTabIdRef = useRef(activeExploreTabId); activeExploreTabIdRef.current = activeExploreTabId;
  const pendingExploreObject = useRef<Pick<DataObject, "namespace" | "name"> | undefined>(undefined);
  const exploreScrollPositions = useRef<Record<string, { left: number; top: number }>>({});
  const exploreGridSelections = useRef<Record<string, { anchor: GridCell; active: GridCell }>>({});
  const tableScrollElement = useRef<HTMLDivElement | null>(null);
  const exploreTabDataCache = useRef<Map<string, ExploreTabDataCacheEntry>>(new Map());
  const displayedResultSignature = useRef("");
  const desiredExploreQuerySignature = useRef("");
  const pendingExploreTabActivation = useRef<{ tabId: string; cursor?: string | undefined } | undefined>(undefined);
  const previousSection = useRef<Section>(section);
  const connectionSelection = useRef<Partial<Record<DatabaseTransportMode, string>>>({
    local: localStorage.getItem("orbit.connection.local") ?? (runtime === "desktop" ? params.get("connection") ?? "" : ""),
    gateway: localStorage.getItem("orbit.connection.gateway") ?? (runtime === "web" ? params.get("connection") ?? "" : ""),
  });
  const objectSelection = useRef<Partial<Record<DatabaseTransportMode, string>>>({
    local: localStorage.getItem("orbit.object.local") ?? (runtime === "desktop" ? params.get("object") ?? "" : ""),
    gateway: localStorage.getItem("orbit.object.gateway") ?? (runtime === "web" ? params.get("object") ?? "" : ""),
  });
  function startWindowDrag() { if (runtime === "desktop") void getCurrentWindow().startDragging().catch(() => undefined); }
  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let nextWidth = startWidth;
    setResizingSidebar(true);
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      nextWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setSidebarWidth(nextWidth);
    };
    const handleUp = () => {
      localStorage.setItem("orbit.sidebarWidth", String(nextWidth));
      setResizingSidebar(false);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; localStorage.setItem("orbit.theme", theme); }, [theme]);
  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); setMenu(false); setCommandOpen((current) => !current); return; }
      if (!modifier || section !== "explore" || commandOpen || managing) return;
      if (event.key.toLowerCase() === "w" && activeExploreTabIdRef.current) { event.preventDefault(); closeExploreWorkspaceTab(activeExploreTabIdRef.current); return; }
      if (event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")) { event.preventDefault(); moveExploreWorkspaceTab(event.code === "BracketLeft" ? -1 : 1); return; }
      if (!event.shiftKey && /^[1-9]$/.test(event.key)) { const tab = exploreTabsRef.current[Number(event.key) - 1]; if (tab) { event.preventDefault(); activateExploreTab(tab); } }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [section, commandOpen, managing]);

  const connection = connections.find((item) => item.id === connectionId);
  const selectedObject = objects.find((item) => objectKey(item) === objectName);
  const visibleColumns = useMemo(() => orderPinnedColumns(result?.columns.filter((column) => !hidden.has(column.name)) ?? [], pinned), [result, hidden, pinned]);
  const objectGroups = useMemo(() => {
    const needle = objectSearch.trim().toLowerCase();
    const names = new Set(namespaces);
    for (const item of objects) names.add(item.namespace);
    return [...names].sort((left, right) => left.localeCompare(right)).map((namespace) => {
      const items = objects.filter((item) => item.namespace === namespace && (!needle || `${item.namespace}.${item.name}`.toLowerCase().includes(needle)));
      return [namespace, items] as const;
    }).filter(([namespace, items]) => !needle || namespace.toLowerCase().includes(needle) || items.length > 0);
  }, [objects, namespaces, objectSearch]);
  const visibleRows = useMemo(() => { const needle = rowSearch.trim().toLowerCase(); if (!needle) return result?.rows ?? []; return (result?.rows ?? []).filter((row) => Object.values(row).some((value) => display(value).toLowerCase().includes(needle))); }, [result, rowSearch]);
  const selectedGridRange = gridRange(gridAnchor, gridActive);
  const selectedGridLabel = `${selectedGridRange.cellCount.toLocaleString()} cell${selectedGridRange.cellCount === 1 ? "" : "s"}`;
  const objectTotal = connection?.kind === "mongodb" ? documentCount?.result?.count ?? selectedObject?.estimatedRows : result?.totalRows ?? selectedObject?.estimatedRows;
  const objectTotalApproximate = connection?.kind === "mongodb" ? documentCount?.result?.estimated ?? documentCount?.result === undefined : result?.totalRows === undefined;
  const objectNoun = connection?.kind === "mongodb" ? "documents" : "rows";
  const pageStart = visibleRows.length ? cursors.length * 50 + 1 : 0;
  const pageEnd = visibleRows.length ? pageStart + visibleRows.length - 1 : 0;
  const pageSummary = visibleRows.length
    ? `${pageStart.toLocaleString()}–${pageEnd.toLocaleString()}${objectTotal == null ? "" : ` of ${objectTotalApproximate ? "~" : ""}${objectTotal.toLocaleString()} ${objectNoun}`}`
    : `0 ${objectNoun}`;
  const visibleColumnKey = visibleColumns.map((column) => `${pinned.has(column.name) ? "p" : "u"}:${column.name}`).join("|");

  useLayoutEffect(() => {
    const measure = () => {
      const next = pinnedColumnOffsets(visibleColumns, pinned, (name) => headerCells.current.get(name)?.getBoundingClientRect().width ?? 160);
      setPinOffsets((current) => {
        const names = Object.keys(next);
        return names.length === Object.keys(current).length && names.every((name) => Math.abs((current[name] ?? -1) - next[name]!) < 0.5) ? current : next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    for (const column of visibleColumns) { const element = headerCells.current.get(column.name); if (element) observer?.observe(element); }
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [visibleColumnKey]);

  const updateUrl = useCallback((connectionValue: string, objectValue: string, search = rowSearch) => { const next = new URLSearchParams(); if (connectionValue) next.set("connection", connectionValue); if (objectValue) next.set("object", objectValue); if (search) next.set("search", search); history.replaceState(null, "", `${location.pathname}?${next}`); }, [rowSearch]);
  const reloadConnections = useCallback(async () => { const items = await dbApi.connections(); setConnections(items); return items; }, [dbApi]);

  useEffect(() => {
    let active = true;
    if (transportMode === exploreTransport) setExploreTabsHydrated(false);
    setLoading(true); setError(undefined); setConnections([]); setConnectionId(""); setObjects([]); setNamespaces([]); setResult(undefined); setFilters([]); setSort([]);
    dbApi.connections().then((items) => {
      if (!active) return;
      setConnections(items);
      const preferred = connectionSelection.current[transportMode];
      const id = items.some((item) => item.id === preferred) ? preferred! : items[0]?.id ?? "";
      connectionSelection.current[transportMode] = id;
      if (id) localStorage.setItem(`orbit.connection.${transportMode}`, id);
      else localStorage.removeItem(`orbit.connection.${transportMode}`);
      setConnectionId(id);
      if (!id) { setLoading(false); if (transportMode === exploreTransport) setExploreTabsHydrated(true); }
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof ApiRequestError ? reason : new ApiRequestError(reason instanceof Error ? reason.message : String(reason), transportMode === "local" ? "LOCAL_UNAVAILABLE" : "GATEWAY_OFFLINE"));
      setLoading(false);
      if (transportMode === exploreTransport) setExploreTabsHydrated(true);
    });
    return () => { active = false; };
  }, [dbApi, transportMode, exploreTransport]);
  useEffect(() => { if (sharedToken) api.sharedView(sharedToken).then(setSharedView).catch((reason: unknown) => setSharedError(reason instanceof Error ? reason.message : "This shared view is unavailable.")); }, []);
  useEffect(() => { setGridAnchor((cell) => clampGridCell(cell, visibleRows.length, visibleColumns.length)); setGridActive((cell) => clampGridCell(cell, visibleRows.length, visibleColumns.length)); }, [visibleRows.length, visibleColumns.length]);
  useEffect(() => { const saved = exploreGridSelections.current[activeExploreTabId]; setGridAnchor(saved?.anchor ?? { row: 0, column: 0 }); setGridActive(saved?.active ?? { row: 0, column: 0 }); setGridCopyNotice(""); }, [objectName, activeExploreTabId]);
  useEffect(() => { if (!gridCopyNotice) return; const timeout = window.setTimeout(() => setGridCopyNotice(""), 1800); return () => window.clearTimeout(timeout); }, [gridCopyNotice]);
  useLayoutEffect(() => { if (section !== "explore" || !result || !activeExploreTabId) return; const position = exploreScrollPositions.current[activeExploreTabId]; if (!position) return; const frame = window.requestAnimationFrame(() => { if (tableScrollElement.current) { tableScrollElement.current.scrollLeft = position.left; tableScrollElement.current.scrollTop = position.top; } }); return () => window.cancelAnimationFrame(frame); }, [section, result, activeExploreTabId]);
  useEffect(() => { if ((section === "views" || commandOpen) && transportMode === "gateway") api.views().then(setViews).catch((reason: unknown) => setViewError(reason instanceof Error ? reason.message : "Views could not be loaded.")); }, [section, commandOpen, transportMode]);
  useEffect(() => {
    if (!connectionId) return;
    let active = true;
    setLoading(true); setError(undefined); setObjects([]); setNamespaces([]); setResult(undefined); setObjectGroupErrors({}); setLoadingObjectGroups(new Set()); loadedObjectGroups.current.clear();
    const applyResponse = (response: ObjectListResult, fromCache: boolean) => {
      if (!active) return;
      const namespaceList = response.namespaces ?? [...new Set(response.objects.map((item) => item.namespace))];
      const mongoGroups = response.namespaces !== undefined;
      const firstNamespace = namespaceList[0];
      let combined = response.objects;
      if (!fromCache) writeObjectSchemaCache(transportMode, connectionId, response);
      if (mongoGroups && firstNamespace) {
        const firstKey = `${transportMode}:${connectionId}:${firstNamespace}`;
        loadedObjectGroups.current.add(firstKey);
        if (!fromCache) writeObjectGroupCache(transportMode, connectionId, firstNamespace, response.objects.filter((item) => item.namespace === firstNamespace));
      }
      const expanded = mongoGroups ? readExpandedObjectGroups(transportMode, connectionId).filter((namespace) => namespaceList.includes(namespace)) : namespaceList;
      if (mongoGroups) {
        setCollapsedObjectGroups(new Set(namespaceList.filter((namespace) => !expanded.includes(namespace)).map((namespace) => `${connectionId}:${namespace}`)));
        for (const namespace of expanded) {
          if (namespace === firstNamespace) continue;
          const cacheKey = `${transportMode}:${connectionId}:${namespace}`;
          const cached = readObjectGroupCache(transportMode, connectionId, namespace);
          if (cached) { combined = mergeNamespaceObjects(combined, namespace, cached); loadedObjectGroups.current.add(cacheKey); continue; }
          setLoadingObjectGroups((current) => new Set(current).add(cacheKey));
          void dbApi.objectsInNamespace(connectionId, namespace).then((result) => {
            if (!active || activeConnectionId.current !== connectionId) return;
            loadedObjectGroups.current.add(cacheKey); writeObjectGroupCache(transportMode, connectionId, namespace, result.objects);
            setObjects((current) => mergeNamespaceObjects(current, namespace, result.objects));
          }).catch((reason: unknown) => { if (active) setObjectGroupErrors((current) => ({ ...current, [cacheKey]: reason instanceof Error ? reason.message : String(reason) })); }).finally(() => { if (active) setLoadingObjectGroups((current) => { const next = new Set(current); next.delete(cacheKey); return next; }); });
        }
      } else setCollapsedObjectGroups(new Set());
      setNamespaces(namespaceList); setObjects(combined);
      const pendingObjectKey = transportMode === exploreTransport && pendingExploreObject.current ? objectKey(pendingExploreObject.current) : "";
      const preferredObject = pendingObjectKey || objectSelection.current[transportMode] || "";
      const current = combined.find((item) => objectKey(item) === preferredObject || item.name === preferredObject);
      const key = current ? objectKey(current) : response.objects[0] ? objectKey(response.objects[0]) : "";
      if (pendingObjectKey && current) pendingExploreObject.current = undefined;
      objectSelection.current[transportMode] = key;
      if (key) localStorage.setItem(`orbit.object.${transportMode}`, key);
      else localStorage.removeItem(`orbit.object.${transportMode}`);
      const activeTab = transportMode === exploreTransport ? exploreTabsRef.current.find((tab) => tab.id === activeExploreTabIdRef.current && tab.connectionId === connectionId && `${tab.namespace}.${tab.object}` === key) : undefined;
      if (activeTab) {
        pendingExploreTabActivation.current = { tabId: activeTab.id, ...(activeTab.cursors.at(-1) ? { cursor: activeTab.cursors.at(-1) } : {}) };
        setFilters(activeTab.filters); setSort(activeTab.sort); setCursors(activeTab.cursors); setHidden(new Set(activeTab.hidden)); setPinned(new Set(activeTab.pinned)); setRowSearch(activeTab.rowSearch);
      }
      setObjectName(key); updateUrl(connectionId, key, activeTab?.rowSearch ?? "");
      if (transportMode === exploreTransport) setExploreTabsHydrated(true);
      if (!key) setLoading(false);
    };
    const cached = readObjectSchemaCache(transportMode, connectionId);
    if (cached) applyResponse(cached, true);
    else void dbApi.objects(connectionId).then((response) => applyResponse(response, false)).catch((reason: unknown) => { if (!active) return; setError(reason instanceof ApiRequestError ? reason : new ApiRequestError(reason instanceof Error ? reason.message : String(reason), "SCHEMA_FAILED")); setLoading(false); if (transportMode === exploreTransport) setExploreTabsHydrated(true); });
    return () => { active = false; };
  }, [connectionId, dbApi, transportMode, exploreTransport]);
  useEffect(() => {
    if (section === "explore" && previousSection.current !== "explore") {
      const tab = exploreTabsRef.current.find((item) => item.id === activeExploreTabIdRef.current);
      if (tab) pendingExploreTabActivation.current = { tabId: tab.id, ...(tab.cursors.at(-1) ? { cursor: tab.cursors.at(-1) } : {}) };
    }
    previousSection.current = section;
  }, [section]);
  const loadRows = useCallback((cursor?: string) => {
    if (!connection || !selectedObject) return;
    const tabId = exploreTabId({ connectionId: connection.id, namespace: selectedObject.namespace, object: selectedObject.name });
    const signature = exploreDataQuerySignature(connection.id, selectedObject.namespace, selectedObject.name, filters, sort, cursor);
    desiredExploreQuerySignature.current = signature;
    setLoading(true); setError(undefined);
    dbApi.explore({ connectionId: connection.id, namespace: selectedObject.namespace, object: selectedObject.name, limit: 50, ...(cursor ? { cursor } : {}), ...(filters.length ? { filters } : {}), ...(sort.length ? { sort } : {}) }).then((response) => {
      const previous = exploreTabDataCache.current.get(tabId);
      exploreTabDataCache.current.set(tabId, { signature, result: response, ...(previous?.documentCount ? { documentCount: previous.documentCount } : {}) });
      if (activeExploreTabIdRef.current !== tabId || desiredExploreQuerySignature.current !== signature) return;
      displayedResultSignature.current = signature; setResult(response);
    }).catch((reason: unknown) => {
      if (activeExploreTabIdRef.current === tabId && desiredExploreQuerySignature.current === signature) setError(reason instanceof ApiRequestError ? reason : new ApiRequestError(reason instanceof Error ? reason.message : String(reason), "EXPLORE_FAILED"));
    }).finally(() => { if (activeExploreTabIdRef.current === tabId && desiredExploreQuerySignature.current === signature) setLoading(false); });
  }, [connection, selectedObject, filters, sort, dbApi]);
  useEffect(() => {
    if (section !== "explore" || !exploreTabsHydrated || !connection || !selectedObject) return;
    const tabId = exploreTabId({ connectionId: connection.id, namespace: selectedObject.namespace, object: selectedObject.name });
    if (activeExploreTabId !== tabId) return;
    const activation = pendingExploreTabActivation.current?.tabId === tabId ? pendingExploreTabActivation.current : undefined;
    if (activation) pendingExploreTabActivation.current = undefined;
    const cursor = activation?.cursor;
    const signature = exploreDataQuerySignature(connection.id, selectedObject.namespace, selectedObject.name, filters, sort, cursor);
    const cached = exploreTabDataCache.current.get(tabId);
    if (activation && cached?.signature === signature) {
      desiredExploreQuerySignature.current = signature; displayedResultSignature.current = signature;
      setResult(cached.result); if (cached.documentCount) setDocumentCount(cached.documentCount); setLoading(false); setError(undefined); updateUrl(connectionId, objectName);
      return;
    }
    if (!activation) setCursors([]);
    loadRows(cursor); updateUrl(connectionId, objectName);
  }, [section, exploreTabsHydrated, activeExploreTabId, connectionId, objectName, filters, sort, loadRows]);
  useEffect(() => {
    if (!connection || !selectedObject || connection.kind !== "mongodb") { setDocumentCount(undefined); return; }
    const request: DocumentCountRequest = { connectionId: connection.id, namespace: selectedObject.namespace, object: selectedObject.name, ...(filters.length ? { filters } : {}) };
    const key = `${transportMode}:${documentCountCacheKey(request)}`;
    const cached = freshDocumentCount(documentCountCache.current, key);
    if (cached) { setDocumentCount({ key, loading: false, result: cached }); return; }
    setDocumentCount({ key, loading: true });
    let pending = documentCountRequests.current.get(key);
    if (!pending) {
      pending = dbApi.countDocuments(request).then((count) => { documentCountCache.current.set(key, { result: count, cachedAt: Date.now() }); return count; });
      documentCountRequests.current.set(key, pending);
      void pending.then(() => documentCountRequests.current.delete(key), () => documentCountRequests.current.delete(key));
    }
    let active = true;
    void pending.then((count) => { if (active) setDocumentCount({ key, loading: false, result: count }); }, (reason: unknown) => { if (active) setDocumentCount({ key, loading: false, error: reason instanceof Error ? reason.message : String(reason) }); });
    return () => { active = false; };
  }, [connection, selectedObject, filters, dbApi, transportMode, countRefresh]);

  async function loadNamespaceObjects(namespace: string, force = false) {
    if (!connectionId || connection?.kind !== "mongodb") return;
    const id = connectionId;
    const cacheKey = `${transportMode}:${id}:${namespace}`;
    if (!force && loadedObjectGroups.current.has(cacheKey)) return;
    if (!force) {
      const cached = readObjectGroupCache(transportMode, id, namespace);
      if (cached) { loadedObjectGroups.current.add(cacheKey); setObjects((current) => mergeNamespaceObjects(current, namespace, cached)); return; }
    }
    setLoadingObjectGroups((current) => new Set(current).add(cacheKey)); setObjectGroupErrors((current) => { const next = { ...current }; delete next[cacheKey]; return next; });
    try {
      const response = await dbApi.objectsInNamespace(id, namespace);
      if (activeConnectionId.current !== id) return;
      loadedObjectGroups.current.add(cacheKey); writeObjectGroupCache(transportMode, id, namespace, response.objects); setObjects((current) => mergeNamespaceObjects(current, namespace, response.objects));
    } catch (reason) {
      if (activeConnectionId.current === id) setObjectGroupErrors((current) => ({ ...current, [cacheKey]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      if (activeConnectionId.current === id) setLoadingObjectGroups((current) => { const next = new Set(current); next.delete(cacheKey); return next; });
    }
  }

  async function refreshObjectSchema() {
    if (!connectionId || refreshingSchema) return;
    const id = connectionId;
    setRefreshingSchema(true); setError(undefined);
    try {
      const response = await dbApi.refreshSchema(id); documentCountCache.current.clear();
      const namespaceList = response.namespaces ?? [...new Set(response.objects.map((item) => item.namespace))];
      try { localStorage.removeItem(objectSchemaCacheKey(transportMode, id)); } catch { /* cache is optional */ }
      for (const namespace of new Set([...namespaces, ...namespaceList])) { try { localStorage.removeItem(objectGroupCacheKey(transportMode, id, namespace)); } catch { /* cache is optional */ } }
      writeObjectSchemaCache(transportMode, id, response);
      loadedObjectGroups.current.clear(); setNamespaces(namespaceList); setObjects(response.objects); setObjectGroupErrors({});
      if (response.namespaces) {
        const firstNamespace = namespaceList[0];
        if (firstNamespace) { loadedObjectGroups.current.add(`${transportMode}:${id}:${firstNamespace}`); writeObjectGroupCache(transportMode, id, firstNamespace, response.objects.filter((item) => item.namespace === firstNamespace)); }
        const expanded = readExpandedObjectGroups(transportMode, id).filter((namespace) => namespaceList.includes(namespace));
        setCollapsedObjectGroups(new Set(namespaceList.filter((namespace) => !expanded.includes(namespace)).map((namespace) => `${id}:${namespace}`)));
        await Promise.all(expanded.filter((namespace) => namespace !== firstNamespace).map((namespace) => loadNamespaceObjects(namespace, true)));
      } else {
        setCollapsedObjectGroups(new Set());
        if (objectName && !response.objects.some((item) => objectKey(item) === objectName)) setObjectName(response.objects[0] ? objectKey(response.objects[0]) : "");
      }
      setCountRefresh((current) => current + 1); await reloadConnections();
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason : new ApiRequestError(reason instanceof Error ? reason.message : String(reason), "SCHEMA_REFRESH_FAILED"));
    } finally {
      setRefreshingSchema(false);
    }
  }

  function currentExploreWorkspace(): ExploreTabWorkspace { return { filters, sort, cursors, hidden: [...hidden], pinned: [...pinned], rowSearch }; }
  function snapshotExploreTabs(tabs: ExploreTab[]) {
    const active = tabs.find((tab) => tab.id === activeExploreTabIdRef.current);
    if (!active || active.connectionId !== connectionId || `${active.namespace}.${active.object}` !== objectName) return tabs;
    const workspace = currentExploreWorkspace();
    const customized = Boolean(workspace.filters.length || workspace.sort.length || workspace.cursors.length || workspace.hidden.length || workspace.pinned.length || workspace.rowSearch.trim());
    const preview = active.preview && !customized;
    if (exploreWorkspaceSignature(active) === exploreWorkspaceSignature(workspace) && active.preview === preview) return tabs;
    return tabs.map((tab) => tab.id === active.id ? { ...tab, ...workspace, preview } : tab);
  }
  function commitExploreTabs(tabs: ExploreTab[]) { exploreTabsRef.current = tabs; setExploreTabs(tabs); }
  function activateExploreTab(tab: ExploreTab, snapshot = true) {
    if (snapshot) commitExploreTabs(snapshotExploreTabs(exploreTabsRef.current));
    const previousId = activeExploreTabIdRef.current;
    const switchingTabs = previousId !== tab.id;
    if (previousId && switchingTabs) {
      exploreGridSelections.current[previousId] = { anchor: gridAnchor, active: gridActive };
      if (tableScrollElement.current) exploreScrollPositions.current[previousId] = { left: tableScrollElement.current.scrollLeft, top: tableScrollElement.current.scrollTop };
      if (result && displayedResultSignature.current) exploreTabDataCache.current.set(previousId, { signature: displayedResultSignature.current, result, ...(documentCount ? { documentCount } : {}) });
    }
    if (switchingTabs) pendingExploreTabActivation.current = { tabId: tab.id, ...(tab.cursors.at(-1) ? { cursor: tab.cursors.at(-1) } : {}) };
    activeExploreTabIdRef.current = tab.id; setActiveExploreTabId(tab.id);
    connectionSelection.current[exploreTransport] = tab.connectionId; objectSelection.current[exploreTransport] = `${tab.namespace}.${tab.object}`;
    localStorage.setItem(`orbit.connection.${exploreTransport}`, tab.connectionId); localStorage.setItem(`orbit.object.${exploreTransport}`, `${tab.namespace}.${tab.object}`);
    const savedGrid = exploreGridSelections.current[tab.id]; setGridAnchor(savedGrid?.anchor ?? { row: 0, column: 0 }); setGridActive(savedGrid?.active ?? { row: 0, column: 0 });
    setFilters(tab.filters); setSort(tab.sort); setCursors(tab.cursors); setHidden(new Set(tab.hidden)); setPinned(new Set(tab.pinned)); setRowSearch(tab.rowSearch); setSelectedRow(undefined); setMenu(false);
    if (connectionId !== tab.connectionId) { setExploreTabsHydrated(false); setConnectionId(tab.connectionId); setObjectName(`${tab.namespace}.${tab.object}`); setResult(undefined); updateUrl(tab.connectionId, `${tab.namespace}.${tab.object}`, tab.rowSearch); }
    else { setObjectName(`${tab.namespace}.${tab.object}`); updateUrl(tab.connectionId, `${tab.namespace}.${tab.object}`, tab.rowSearch); }
  }
  function openExploreTarget(target: ExploreTabTarget, persistent = false) {
    const current = section === "explore" ? snapshotExploreTabs(exploreTabsRef.current) : exploreTabsRef.current;
    const opened = openExploreTab(current, target, persistent);
    commitExploreTabs(opened.tabs);
    const tab = opened.tabs.find((candidate) => candidate.id === opened.activeId);
    if (!tab) return;
    setRecentExploreTargets((recent) => { const next = [target, ...recent.filter((item) => exploreTabId(item) !== tab.id)].slice(0, 10); localStorage.setItem(`orbit.exploreRecent.${exploreTransport}`, JSON.stringify(next)); return next; });
    if (section === "explore") activateExploreTab(tab, false);
    else {
      activeExploreTabIdRef.current = tab.id; setActiveExploreTabId(tab.id);
      connectionSelection.current[exploreTransport] = tab.connectionId; objectSelection.current[exploreTransport] = `${tab.namespace}.${tab.object}`;
      localStorage.setItem(`orbit.connection.${exploreTransport}`, tab.connectionId); localStorage.setItem(`orbit.object.${exploreTransport}`, `${tab.namespace}.${tab.object}`);
      setSection("explore");
    }
  }
  function openExploreObject(item: DataObject, persistent = false) { if (connection) openExploreTarget({ connectionId: connection.id, connectionName: connection.name, databaseKind: connection.kind, namespace: item.namespace, object: item.name, objectKind: item.kind }, persistent); }
  function promoteExploreWorkspaceTab(id: string) { commitExploreTabs(exploreTabsRef.current.map((tab) => tab.id === id ? { ...tab, preview: false } : tab)); }
  function closeExploreWorkspaceTab(id: string) {
    const current = snapshotExploreTabs(exploreTabsRef.current);
    const closed = closeExploreTabState(current, activeExploreTabIdRef.current, id);
    commitExploreTabs(closed.tabs);
    if (closed.activeId && closed.activeId !== activeExploreTabIdRef.current) { const next = closed.tabs.find((tab) => tab.id === closed.activeId); if (next) activateExploreTab(next, false); }
    else if (!closed.activeId) { activeExploreTabIdRef.current = ""; setActiveExploreTabId(""); objectSelection.current[exploreTransport] = ""; localStorage.removeItem(`orbit.object.${exploreTransport}`); setObjectName(""); setResult(undefined); setSelectedRow(undefined); updateUrl(connectionId, ""); }
  }
  function moveExploreWorkspaceTab(direction: -1 | 1) { const id = cycleExploreTab(exploreTabsRef.current, activeExploreTabIdRef.current, direction); const tab = exploreTabsRef.current.find((item) => item.id === id); if (tab) activateExploreTab(tab); }
  function selectConnection(id: string) { if (section === "explore") { commitExploreTabs(snapshotExploreTabs(exploreTabsRef.current)); setExploreTabsHydrated(false); } connectionSelection.current[transportMode] = id; objectSelection.current[transportMode] = ""; if (id) localStorage.setItem(`orbit.connection.${transportMode}`, id); else localStorage.removeItem(`orbit.connection.${transportMode}`); localStorage.removeItem(`orbit.object.${transportMode}`); setConnectionId(id); setObjectName(""); setFilters([]); setSort([]); setCursors([]); setHidden(new Set()); setPinned(new Set()); setMenu(false); updateUrl(id, ""); }
  function selectObject(item: Pick<DataObject, "namespace" | "name"> | string, persistent = false) { const target = typeof item === "string" ? objects.find((object) => object.name === item) : objects.find((object) => object.namespace === item.namespace && object.name === item.name); if (!target) return; if (section !== "explore") { pendingExploreObject.current = target; setSection("explore"); return; } openExploreObject(target, persistent); }

  useEffect(() => {
    if (section !== "explore" || !exploreTabsHydrated || !connection || !selectedObject) return;
    const id = exploreTabId({ connectionId: connection.id, namespace: selectedObject.namespace, object: selectedObject.name });
    if (!exploreTabsRef.current.some((tab) => tab.id === id)) openExploreObject(selectedObject);
  }, [section, exploreTabsHydrated, connectionId, objectName]);

  useEffect(() => {
    if (section !== "explore" || !exploreTabsHydrated || !activeExploreTabIdRef.current) return;
    const next = snapshotExploreTabs(exploreTabsRef.current);
    if (next !== exploreTabsRef.current) commitExploreTabs(next);
  }, [section, exploreTabsHydrated, filters, sort, cursors, hidden, pinned, rowSearch, connectionId, objectName]);
  function toggleObjectGroup(namespace: string) {
    const key = `${connectionId}:${namespace}`; const expanding = collapsedObjectGroups.has(key);
    const next = new Set(collapsedObjectGroups); if (expanding) next.delete(key); else next.add(key); setCollapsedObjectGroups(next);
    if (connection?.kind === "mongodb") { writeExpandedObjectGroups(transportMode, connectionId, namespaces.filter((item) => !next.has(`${connectionId}:${item}`))); if (expanding) void loadNamespaceObjects(namespace); }
  }
  function revealNamespace(namespace: string) {
    setSection("explore");
    const key = `${connectionId}:${namespace}`;
    if (collapsedObjectGroups.has(key)) toggleObjectGroup(namespace);
    else if (connection?.kind === "mongodb") void loadNamespaceObjects(namespace);
  }
  function openRow(row: Record<string, unknown>) { setSelectedRow(row); setReferenceTrail([]); setReferenceLookup(undefined); }
  function applyReferenceResult(context: ReferenceLookupRequest, response: ReferenceLookupResult, resetTrail: boolean) { if (response.matches.length === 1) { setReferenceTrail((current) => resetTrail ? [response.matches[0]!] : [...current, response.matches[0]!]); setReferenceLookup(undefined); } else setReferenceLookup({ context, loading: false, result: response }); }
  async function resolveReference(context: ReferenceLookupRequest, resetTrail = false) { const cacheKey = JSON.stringify([context.connectionId, context.database, context.sourceCollection, context.field, context.value, context.reference, context.searchAll]); const cached = referenceCache.current.get(cacheKey); if (cached) { applyReferenceResult(context, cached, resetTrail); return; } setReferenceLookup({ context, loading: true }); try { const response = await dbApi.resolveReference(context); referenceCache.current.set(cacheKey, response); applyReferenceResult(context, response, resetTrail); } catch (reason) { setReferenceLookup({ context, loading: false, error: reason instanceof Error ? reason.message : String(reason) }); } }
  function openCellReference(row: Record<string, unknown>, field: string, value: unknown, reference?: DataColumn["reference"]) { if (!connection || !selectedObject) return; openRow(row); void resolveReference({ connectionId: connection.id, database: selectedObject.namespace, sourceCollection: selectedObject.name, field, value, searchAll: false, ...(reference ? { reference } : {}) }, true); }
  function openNestedReference(database: string, collection: string, field: string, value: unknown, reference?: DataColumn["reference"]) { if (!connection) return; void resolveReference({ connectionId: connection.id, database, sourceCollection: collection, field, value, searchAll: false, ...(reference ? { reference } : {}) }); }
  function searchAllReferenceCollections() { if (!referenceLookup) return; void resolveReference({ ...referenceLookup.context, searchAll: true }); }
  function chooseLinkedDocument(document: LinkedDocument) { setReferenceTrail((current) => [...current, document]); setReferenceLookup(undefined); }
  function closeInspector() { setSelectedRow(undefined); setReferenceTrail([]); setReferenceLookup(undefined); }
  function toggleSort(column: string) { setSort((current) => current[0]?.column !== column ? [{ column, direction: "asc" }] : current[0].direction === "asc" ? [{ column, direction: "desc" }] : []); }
  function togglePin(column: string) { setPinned((current) => { const next = new Set(current); if (next.has(column)) next.delete(column); else next.add(column); return next; }); }
  function hideColumn(column: string) { setHidden((current) => new Set(current).add(column)); setPinned((current) => { if (!current.has(column)) return current; const next = new Set(current); next.delete(column); return next; }); }
  function selectGridCell(cell: GridCell, extend = false) { const next = clampGridCell(cell, visibleRows.length, visibleColumns.length); setGridActive(next); if (!extend) setGridAnchor(next); window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-grid-cell="${next.row}-${next.column}"]`)?.focus()); }
  async function copyGridSelection(includeHeaders = false) { const text = gridSelectionToTsv(visibleRows, visibleColumns.map((column) => column.name), selectedGridRange, includeHeaders); if (!text && !selectedGridRange.cellCount) return; try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text); else { const input = document.createElement("textarea"); input.value = text; input.style.position = "fixed"; input.style.opacity = "0"; document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove(); } setGridCopyNotice(includeHeaders ? "Copied with headers" : "Copied"); } catch { setGridCopyNotice("Copy failed"); } }
  function handleGridKeyDown(event: ReactKeyboardEvent<HTMLTableCellElement>, rowIndex: number, columnIndex: number, row: Record<string, unknown>) {
    if (event.target !== event.currentTarget) return;
    const cell = { row: rowIndex, column: columnIndex };
    const direction = event.key === "ArrowUp" ? [-1, 0] : event.key === "ArrowDown" ? [1, 0] : event.key === "ArrowLeft" ? [0, -1] : event.key === "ArrowRight" ? [0, 1] : undefined;
    if (direction) { event.preventDefault(); selectGridCell(moveGridCell(cell, direction[0]!, direction[1]!, visibleRows.length, visibleColumns.length), event.shiftKey); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") { event.preventDefault(); void copyGridSelection(event.shiftKey); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setGridAnchor({ row: 0, column: 0 }); setGridActive({ row: Math.max(0, visibleRows.length - 1), column: Math.max(0, visibleColumns.length - 1) }); return; }
    if (event.key === "Enter") { event.preventDefault(); openRow(row); }
    if (event.key === "Escape") { event.preventDefault(); setGridAnchor(cell); setGridActive(cell); }
  }
  function exportRows(format: "csv" | "json") { if (!result || !selectedObject) return; const content = format === "json" ? JSON.stringify(visibleRows, null, 2) : [visibleColumns.map((c) => c.name).join(","), ...visibleRows.map((row) => visibleColumns.map((c) => `"${display(row[c.name]).replaceAll('"', '""')}"`).join(","))].join("\n"); const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${selectedObject.name}.${format}`; anchor.click(); URL.revokeObjectURL(url); }
  function openCreate() { setEditing(undefined); setConnectionForm(emptyConnection()); setConnectionString(defaultConnectionString("mongodb")); setManagerError(""); setFormOpen(true); }
  function openEdit(item: DatabaseConnection) { setEditing(item); setConnectionForm({ name: item.name, kind: item.kind, environment: item.environment, host: "", port: defaultPort(item.kind), database: item.database, username: "", password: "", tls: true }); setManagerError(""); setFormOpen(true); }
  async function saveConnection(event: FormEvent) { event.preventDefault(); setSaving(true); setManagerError(""); try { if (editing) await dbApi.updateConnection(editing.id, { name: connectionForm.name, environment: connectionForm.environment }); else await dbApi.createConnection(connectionForm.kind === "mongodb" || connectionForm.kind === "postgres" ? { ...connectionForm, connectionString } : connectionForm); const items = await reloadConnections(); if (!editing) selectConnection(items.at(-1)?.id ?? connectionId); setFormOpen(false); } catch (reason) { setManagerError(reason instanceof Error ? reason.message : String(reason)); } finally { setSaving(false); } }
  async function testManagedConnection(id: string) { setTestingId(id); setManagerError(""); try { await dbApi.testConnection(id); await reloadConnections(); } catch (reason) { setManagerError(reason instanceof Error ? reason.message : String(reason)); } finally { setTestingId(""); } }
  async function removeManagedConnection(item: DatabaseConnection) { if (!confirm(`Remove ${item.name}? The encrypted credential reference will also be deleted.`)) return; setManagerError(""); try { await dbApi.removeConnection(item.id); const items = await reloadConnections(); if (connectionId === item.id) selectConnection(items[0]?.id ?? ""); } catch (reason) { setManagerError(reason instanceof Error ? reason.message : String(reason)); } }
  async function generateAskDraft(event: FormEvent) { event.preventDefault(); if (!connection || !question.trim()) return; setAskState("generating"); setAskTrace([]); setAskError(undefined); setAskDraft(undefined); setAskResult(undefined); try { const draft = await api.draftAskStream({ connectionIds: [connection.id], question, ...(selectedObject ? { context: { namespace: selectedObject.namespace, object: selectedObject.name } } : {}) }, (agentEvent) => { if (agentEvent.type === "draft" || agentEvent.type === "error") return; setAskTrace((current) => { const last = current.at(-1); if (agentEvent.type === "output" && last?.type === "output" && last.activityId === agentEvent.activityId) return [...current.slice(0, -1), { ...last, delta: last.delta + agentEvent.delta }]; return [...current, agentEvent]; }); }); setAskDraft(draft); setAskState("ready"); } catch (reason) { setAskError(reason instanceof ApiRequestError ? reason : new ApiRequestError("A query could not be generated.", "ASK_FAILED")); setAskState("idle"); } }
  async function executeAskDraft() { if (!askDraft) return; setAskState("executing"); setAskError(undefined); setAskResult(undefined); try { const response = await api.executeAsk({ connectionId: askDraft.connectionId, question: askDraft.question, query: askDraft.query, queryLanguage: askDraft.queryLanguage, visualization: askDraft.visualization, assumptions: askDraft.assumptions, sourceObjects: askDraft.sourceObjects }); setAskResult(response); setAskState("complete"); } catch (reason) { setAskError(reason instanceof ApiRequestError ? reason : new ApiRequestError("The query could not be executed.", "ASK_EXECUTION_FAILED")); setAskState("ready"); } }
  function resetAsk() { setQuestion(""); setAskDraft(undefined); setAskResult(undefined); setAskError(undefined); setAskTrace([]); setAskState("idle"); }
  async function saveCurrentView(event: FormEvent) { event.preventDefault(); if (!connection || !saveName.trim()) return; setSavingView(true); setViewError(""); try { if (saveDialog === "ask" && askResult) await api.createView({ name: saveName, connectionId: connection.id, component: askResult.visualization?.kind ?? "table", source: { kind: "query", question, query: askResult.query, queryLanguage: askResult.queryLanguage, assumptions: askResult.assumptions, sourceObjects: askResult.sourceObjects }, visualization: askResult.visualization ?? { kind: "table" } }); else if (saveDialog === "explore" && selectedObject) await api.createView({ name: saveName, connectionId: connection.id, component: "table", source: { kind: "explore", namespace: selectedObject.namespace, object: selectedObject.name, filters, sort }, visualization: { kind: "table" } }); setSaveDialog(undefined); setSaveName(""); setSection("views"); setViews(await api.views()); } catch (reason) { setViewError(reason instanceof Error ? reason.message : "View could not be saved."); } finally { setSavingView(false); } }
  async function refreshSavedView(view: SavedView) { setRefreshingView(view.id); setViewError(""); try { const refreshed = await api.refreshView(view.id); setViews((current) => current.map((item) => item.id === view.id ? refreshed.view : item)); setViewResults((current) => ({ ...current, [view.id]: refreshed.result })); } catch (reason) { setViewError(reason instanceof Error ? reason.message : "Refresh failed."); setViews(await api.views()); } finally { setRefreshingView(""); } }
  async function renameSavedView(view: SavedView) { const name = prompt("Rename view", view.name)?.trim(); if (!name || name === view.name) return; const updated = await api.updateView(view.id, { name }); setViews((current) => current.map((item) => item.id === view.id ? updated : item)); }
  async function duplicateSavedView(view: SavedView) { const duplicate = await api.duplicateView(view.id); setViews((current) => [...current, duplicate]); }
  async function deleteSavedView(view: SavedView) { if (!confirm(`Delete ${view.name}?`)) return; await api.removeView(view.id); setViews((current) => current.filter((item) => item.id !== view.id)); }
  async function shareSavedView(view: SavedView) { if (view.shared) { await api.revokeViewShare(view.id); setViews(await api.views()); return; } const shared = await api.shareView(view.id); await navigator.clipboard.writeText(shared.url); setViews(await api.views()); setViewError("Share link copied to clipboard."); }

  const activeCommandColumn = visibleColumns[gridActive.column];
  const activeCommandRow = visibleRows[gridActive.row];
  const commandItems: CommandItem[] = [
    { id: "navigate-explore", label: "Go to Explore", description: "Browse tables and collections", keywords: ["home", "data"], category: "navigation", group: "Navigate", icon: "⌘", run: () => setSection("explore") },
    { id: "navigate-ask", label: "Go to Ask", description: "Generate a read-only query with AI", keywords: ["ai", "query"], category: "navigation", group: "Navigate", icon: "✦", run: () => setSection("ask") },
    { id: "navigate-views", label: "Go to Views", description: "Open saved tables and answers", keywords: ["saved", "dashboard"], category: "navigation", group: "Navigate", icon: "▦", run: () => setSection("views") },
    ...recentExploreTargets.map((item): CommandItem => ({ id: `recent-${exploreTabId(item)}`, label: item.object, description: `${item.connectionName} · ${item.namespace}`, keywords: [item.connectionName, item.namespace, item.databaseKind, "recent"], category: "object", group: "Recently viewed", icon: item.objectKind === "collection" ? "●" : item.objectKind === "view" ? "◇" : "▦", run: () => openExploreTarget(item) })),
    ...connections.map((item): CommandItem => ({ id: `connection-${item.id}`, label: item.name, description: `${item.kind} · ${item.environment} · ${item.database}`, keywords: [item.kind, item.environment, item.database, "switch connection"], category: "connection", group: "Connections", icon: item.kind === "mongodb" ? "M" : item.kind === "postgres" ? "P" : "my", run: () => selectConnection(item.id) })),
    ...namespaces.map((namespace): CommandItem => ({ id: `database-${connectionId}-${namespace}`, label: namespace, description: `${connection?.kind === "mongodb" ? "Database" : "Schema"} in ${connection?.name ?? "current connection"}`, keywords: ["database", "schema", connection?.name ?? ""], category: "database", group: connection?.kind === "mongodb" ? "Databases" : "Schemas", icon: "◉", run: () => revealNamespace(namespace) })),
    ...objects.map((item): CommandItem => ({ id: `object-${connectionId}-${objectKey(item)}`, label: item.name, description: `${item.namespace}.${item.name} · ${item.kind}${item.estimatedRows == null ? "" : ` · ~${item.estimatedRows.toLocaleString()} rows`}`, keywords: [item.namespace, item.kind, objectKey(item)], category: "object", group: "Data", icon: item.kind === "collection" ? "●" : item.kind === "view" ? "◇" : "▦", run: () => { revealNamespace(item.namespace); selectObject(item); } })),
    ...(transportMode === "gateway" ? views.map((view): CommandItem => ({ id: `view-${view.id}`, label: view.name, description: `${view.component} · ${view.status.replaceAll("_", " ")}`, keywords: [view.component, view.status, "saved view"], category: "view", group: "Views", icon: "#", run: () => { setSection("views"); void refreshSavedView(view); } })) : []),
    { id: "action-manage-connections", label: "Manage connections", description: "Add, edit, test, or remove a connection", keywords: ["database", "settings"], category: "action", group: "Actions", icon: "+", run: () => { setFormOpen(false); setManaging(true); } },
    { id: "action-add-connection", label: "Add database connection", description: `Create a ${transportMode} connection`, keywords: ["new", "connect"], category: "action", group: "Actions", icon: "+", run: () => { setManaging(true); openCreate(); } },
    ...(connectionId ? [{ id: "action-refresh-schema", label: "Refresh databases and schema", description: connection?.name ?? "Current connection", keywords: ["reload", "collections", "tables"], category: "action" as const, group: "Actions", icon: "↻", shortcut: "⌘R", disabled: refreshingSchema, run: refreshObjectSchema }] : []),
    ...(selectedObject ? [
      { id: "action-refresh-data", label: "Refresh current data", description: `${selectedObject.namespace}.${selectedObject.name}`, keywords: ["reload", "rows", "documents"], category: "action" as const, group: "Current table", icon: "↻", run: () => loadRows(cursors.at(-1)) },
      { id: "action-export-csv", label: "Export loaded rows as CSV", description: `${visibleRows.length.toLocaleString()} rows`, keywords: ["download"], category: "action" as const, group: "Current table", icon: "↓", run: () => exportRows("csv") },
      { id: "action-export-json", label: "Export loaded rows as JSON", description: `${visibleRows.length.toLocaleString()} rows`, keywords: ["download"], category: "action" as const, group: "Current table", icon: "{}", run: () => exportRows("json") },
      ...(transportMode === "gateway" ? [
        { id: "action-ask-current", label: "Ask about this data", description: `${selectedObject.namespace}.${selectedObject.name}`, keywords: ["ai", "query"], category: "action" as const, group: "Current table", icon: "✦", run: () => setSection("ask") },
        { id: "action-save-table", label: "Save current table as a view", description: `${selectedObject.namespace}.${selectedObject.name}`, keywords: ["dashboard"], category: "action" as const, group: "Current table", icon: "▥", run: () => { setSaveName(selectedObject.name); setSaveDialog("explore"); } },
      ] : []),
    ] : []),
    ...(visibleRows.length && visibleColumns.length ? [
      { id: "action-copy-selection", label: `Copy ${selectedGridLabel}`, description: "Tab-separated values", keywords: ["clipboard", "cells"], category: "action" as const, group: "Selection", icon: "□", shortcut: "⌘C", run: () => copyGridSelection() },
      { id: "action-copy-selection-headers", label: "Copy selection with headers", description: selectedGridLabel, keywords: ["clipboard", "columns"], category: "action" as const, group: "Selection", icon: "□", shortcut: "⇧⌘C", run: () => copyGridSelection(true) },
    ] : []),
    ...(activeCommandRow ? [{ id: "action-open-row", label: connection?.kind === "mongodb" ? "Open selected document" : "Open selected row", description: `Row ${(gridActive.row + 1).toLocaleString()} in ${selectedObject?.name ?? "current table"}`, keywords: ["inspect", "details"], category: "action" as const, group: "Selection", icon: "↗", shortcut: "↵", run: () => openRow(activeCommandRow) }] : []),
    ...(activeCommandColumn ? [
      { id: "action-pin-column", label: `${pinned.has(activeCommandColumn.name) ? "Unpin" : "Pin"} column “${activeCommandColumn.name}”`, description: activeCommandColumn.nativeType, keywords: ["column", "freeze"], category: "action" as const, group: "Selection", icon: "⌖", run: () => togglePin(activeCommandColumn.name) },
      { id: "action-hide-column", label: `Hide column “${activeCommandColumn.name}”`, description: activeCommandColumn.nativeType, keywords: ["column", "remove"], category: "action" as const, group: "Selection", icon: "×", run: () => hideColumn(activeCommandColumn.name) },
    ] : []),
    ...(filters.length || sort.length ? [{ id: "action-clear-query", label: "Clear filters and sorting", description: `${filters.length} filters · ${sort.length} sorts`, keywords: ["reset", "query"], category: "action" as const, group: "Current table", icon: "×", run: () => { setFilters([]); setSort([]); setCursors([]); } }] : []),
    ...(hidden.size ? [{ id: "action-show-columns", label: `Show ${hidden.size} hidden column${hidden.size === 1 ? "" : "s"}`, description: "Restore all columns", keywords: ["reset", "columns"], category: "action" as const, group: "Current table", icon: "▥", run: () => setHidden(new Set()) }] : []),
    ...(selectedRow ? [{ id: "action-close-inspector", label: "Close record inspector", description: "Return to the full table", keywords: ["drawer", "panel"], category: "action" as const, group: "Actions", icon: "×", shortcut: "esc", run: closeInspector }] : []),
    { id: "action-appearance", label: `Switch to ${theme === "dark" ? "light" : "dark"} mode`, description: "Change Orbit appearance", keywords: ["theme", "appearance"], category: "action", group: "Preferences", icon: theme === "dark" ? "☀" : "☾", run: () => setTheme((current) => current === "dark" ? "light" : "dark") },
  ];

  if (import.meta.env.DEV && params.get("preview") === "charts") return <main className="chart-preview-page"><header><div className="orbit-logo" /><div><strong>Orbit charts</strong><small>Responsive visualization preview</small></div></header><section><LazyResultChart columns={chartPreviewColumns} rows={chartPreviewRows} visualization={{ kind: "bar", x: "month", y: ["users"] }} /></section><section><LazyResultChart columns={chartPreviewColumns} rows={chartPreviewRows} visualization={{ kind: "line", x: "month", y: ["revenue"] }} /></section><section><LazyResultChart columns={chartPreviewColumns} rows={chartPreviewRows} visualization={{ kind: "donut", x: "month", y: ["users"] }} /></section></main>;
  if (sharedToken) return <main className="shared-view-page"><header><div className="orbit-logo" /><strong>Orbit shared view</strong></header>{sharedError ? <div className="status-state error"><strong>Shared view unavailable</strong><p>{sharedError}</p></div> : !sharedView ? <div className="status-state"><span className="spinner" /><strong>Refreshing shared data…</strong></div> : <article className="shared-card"><small>{sharedView.view.component.toUpperCase()}</small><h1>{sharedView.view.name}</h1><p>Refreshed {new Date(sharedView.view.lastRefreshedAt ?? sharedView.view.updatedAt).toLocaleString()}</p>{!["table", "metric"].includes(sharedView.view.component) && <LazyResultChart columns={sharedView.result.columns} rows={sharedView.result.rows} visualization={sharedView.view.visualization} />}<div className="evidence-table"><table><thead><tr>{sharedView.result.columns.map((column) => <th key={column.name}>{column.name}<small>{column.nativeType}</small></th>)}</tr></thead><tbody>{sharedView.result.rows.map((row, index) => <tr key={index}>{sharedView.result.columns.map((column) => <td key={column.name}>{display(row[column.name])}</td>)}</tr>)}</tbody></table></div></article>}</main>;
  if (!connections.length && !loading && error) return <div className="setup-state"><div className="orbit-logo" /><h1>{transportMode === "local" ? "Orbit local access is unavailable" : "Orbit gateway is unavailable"}</h1><p>{error.message}</p><code>{transportMode === "local" ? "Restart the desktop app and try again." : "Start the gateway, then reload this page."}</code>{runtime === "desktop" && transportMode === "gateway" && <><p>Explore remains available through this device's direct database drivers.</p><button className="primary" onClick={() => setSection("explore")}>Back to Explore</button></>}</div>;
  const showOnboarding = (!connections.length && !loading && !error && transportMode === "local") || (import.meta.env.DEV && params.get("preview") === "onboarding");
  if (showOnboarding) return <div className="onboarding-shell">
    <header className="onboarding-titlebar" data-tauri-drag-region onMouseDown={startWindowDrag}><div className="sidebar-brand"><div className="orbit-logo" /><strong>Orbit</strong></div><button className="theme-toggle" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={(event) => { event.stopPropagation(); setTheme((current) => current === "dark" ? "light" : "dark"); }}><AppIcon name={theme === "dark" ? "sun" : "moon"} /></button></header>
    <main className="onboarding-main">
      <aside className="onboarding-aside"><div><small>GET STARTED</small><h1>Bring your data into Orbit.</h1><p>Connect directly from this device. Your credentials never pass through an Orbit server.</p></div><ol><li className={onboardingStep === 1 ? "active" : "complete"}><span>{onboardingStep === 1 ? "1" : "✓"}</span><div><strong>Choose database</strong><small>Select your database engine</small></div></li><li className={onboardingStep === 2 ? "active" : ""}><span>2</span><div><strong>Connect securely</strong><small>Test and save credentials</small></div></li></ol><div className="onboarding-security"><span>⌾</span><div><strong>Stored in your keychain</strong><p>Only connection metadata is saved by Orbit.</p></div></div></aside>
      <section className="onboarding-card">
        {onboardingStep === 1 ? <><header><small>STEP 1 OF 2</small><h2>What are you connecting?</h2><p>Choose a database to configure a direct, read-only connection.</p></header><div className="database-choices">{([{"kind":"mongodb","name":"MongoDB","description":"Use a standard or Atlas connection string.","mark":"M"},{"kind":"postgres","name":"PostgreSQL","description":"Use a standard or hosted Postgres connection string.","mark":"P"},{"kind":"mysql","name":"MySQL","description":"Connect with host, port, and credentials.","mark":"my"}] as const).map((option) => <button className={connectionForm.kind === option.kind ? "selected" : ""} key={option.kind} onClick={() => { setConnectionForm({ ...emptyConnection(), kind: option.kind, port: defaultPort(option.kind) }); setConnectionString(defaultConnectionString(option.kind)); }}><span className={`db-icon ${option.kind}`}>{option.mark}</span><div><strong>{option.name}</strong><p>{option.description}</p></div><i>{connectionForm.kind === option.kind ? "✓" : ""}</i></button>)}</div><footer><span>You can add more connections later.</span><button className="primary" onClick={() => setOnboardingStep(2)}>Continue <AppIcon name="chevron" size={14} /></button></footer></> : <form onSubmit={saveConnection}><header><small>STEP 2 OF 2</small><h2>Connect to {connectionForm.kind === "mongodb" ? "MongoDB" : connectionForm.kind === "postgres" ? "PostgreSQL" : "MySQL"}</h2><p>Orbit tests the connection before storing it on this device.</p></header><div className="onboarding-fields"><div className="form-row"><label>Connection name<input autoFocus required value={connectionForm.name} placeholder="Production analytics" onChange={(event) => setConnectionForm({ ...connectionForm, name: event.target.value })} /></label><label>Environment<select value={connectionForm.environment} onChange={(event) => setConnectionForm({ ...connectionForm, environment: event.target.value as ConnectionEnvironment })}><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label></div>{connectionForm.kind !== "mysql" ? <label>Connection string<input required type="password" autoComplete="off" spellCheck={false} value={connectionString} placeholder={connectionForm.kind === "postgres" ? "postgresql://user:password@host:5432/database?sslmode=require" : "mongodb+srv://user:password@cluster.example.net"} onChange={(event) => setConnectionString(event.target.value)} /><small>{connectionForm.kind === "postgres" ? "Include the database name in the URL. Provider-specific SSL parameters are preserved." : "Orbit will discover every database and collection this account can access."}</small></label> : <><div className="form-row"><label>Host<input required value={connectionForm.host} onChange={(event) => setConnectionForm({ ...connectionForm, host: event.target.value })} /></label><label>Port<input required type="number" value={connectionForm.port} onChange={(event) => setConnectionForm({ ...connectionForm, port: Number(event.target.value) })} /></label></div><label>Database<input required value={connectionForm.database} onChange={(event) => setConnectionForm({ ...connectionForm, database: event.target.value })} /></label><div className="form-row"><label>Username<input required autoComplete="username" value={connectionForm.username} onChange={(event) => setConnectionForm({ ...connectionForm, username: event.target.value })} /></label><label>Password<input required type="password" autoComplete="new-password" value={connectionForm.password} onChange={(event) => setConnectionForm({ ...connectionForm, password: event.target.value })} /></label></div><label className="checkbox"><input type="checkbox" checked={connectionForm.tls} onChange={(event) => setConnectionForm({ ...connectionForm, tls: event.target.checked })} /> Require TLS</label></>}{managerError && <div className="form-error">{managerError}</div>}</div><footer><button type="button" onClick={() => { setManagerError(""); setOnboardingStep(1); }}>Back</button><button className="primary" disabled={saving}>{saving ? <><span className="button-spinner" /> Testing connection…</> : <>Test & connect <AppIcon name="chevron" size={14} /></>}</button></footer></form>}
      </section>
    </main>
  </div>;
  return <div className={`orbit-shell ${runtime}`}>
    <header className="orbit-topbar">
      <div className="topbar-brand" data-tauri-drag-region onMouseDown={startWindowDrag}><div className="orbit-logo" role="img" aria-label="Orbit" /></div>
      <nav className="topbar-nav" aria-label="Primary navigation">{(["explore", "ask", "views"] as Section[]).map((item) => <button className={section === item ? "active" : ""} title={`${item.charAt(0).toUpperCase() + item.slice(1)}${runtime === "desktop" ? item === "explore" ? " · Direct connection" : " · Gateway" : ""}`} key={item} onClick={() => setSection(item)}><AppIcon name={item} size={14} /><span>{item}</span></button>)}</nav>
      <button className="command-trigger" onClick={() => { setMenu(false); setCommandOpen(true); }} aria-haspopup="dialog"><span>⌕</span><span>Search or jump to…</span><kbd>⌘K</kbd></button>
      <div className="topbar-drag-region" data-tauri-drag-region onMouseDown={startWindowDrag} />
      <div className="connection-wrap"><button className="connection-button" onClick={() => setMenu(!menu)} aria-expanded={menu}>{connection ? <><span className={`db-icon ${connection.kind}`}>{icon(connection.kind)}</span><span className="connection-copy"><strong>{connection.name}</strong><small>{connection.database} · {transportMode === "local" ? "Direct" : "Gateway"}</small></span><span className={`mode-dot ${transportMode}`} /><AppIcon name="chevron" size={13} /></> : <><AppIcon name="database" /><strong>No connection</strong><AppIcon name="chevron" size={13} /></>}</button>{menu && <div className="connection-menu"><label>{transportMode === "local" ? "Direct connections" : "Workspace connections"}</label>{connections.map((item) => <button className={item.id === connectionId ? "active" : ""} key={item.id} onClick={() => selectConnection(item.id)}><span className={`db-icon ${item.kind}`}>{icon(item.kind)}</span><span><strong>{item.name}</strong><small>{item.environment} · {item.database} · {item.latencyMs ?? "—"} ms</small></span>{item.id === connectionId && <b>✓</b>}</button>)}<button className="manage" onClick={() => { setMenu(false); setManaging(true); }}><AppIcon name="plus" /> Add or manage connections</button><button className="appearance" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}><AppIcon name={theme === "dark" ? "sun" : "moon"} /><span><strong>Appearance</strong><small>{theme === "dark" ? "Dark" : "Light"} mode</small></span></button></div>}</div>
    </header>
    <main className="orbit-content">
      {section === "explore" && <section className="explore-screen"><div className={`explore-layout${resizingSidebar ? " resizing-sidebar" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
        <aside className="object-list"><div className="object-list-toolbar"><input placeholder={`Search ${connection ? objectLabel(connection) : "objects"}`} value={objectSearch} onChange={(event) => setObjectSearch(event.target.value)} aria-label="Search objects" /><button className={refreshingSchema ? "refreshing" : ""} disabled={!connectionId || refreshingSchema} onClick={() => void refreshObjectSchema()} title="Refresh databases and expanded collections" aria-label="Refresh databases and expanded collections"><AppIcon name="refresh" size={14} /></button></div>{objectGroups.map(([namespace, items]) => { const stateKey = `${transportMode}:${connectionId}:${namespace}`; const collapsed = collapsedObjectGroups.has(`${connectionId}:${namespace}`); const groupLoading = loadingObjectGroups.has(stateKey); const groupError = objectGroupErrors[stateKey]; const loaded = loadedObjectGroups.current.has(stateKey) || connection?.kind !== "mongodb"; return <section className={`object-group${collapsed ? " collapsed" : ""}`} key={namespace}><button className="object-group-header" type="button" aria-expanded={!collapsed} onClick={() => toggleObjectGroup(namespace)} title={namespace}><span className="object-group-chevron">⌄</span><span className="object-group-database-icon"><AppIcon name="database" size={13} /></span><strong>{namespace}</strong><b>{groupLoading ? "…" : loaded ? items.length : "—"}</b></button>{!collapsed && <div className="object-group-items">{groupLoading ? <p className="object-group-state"><span className="spinner" /> Loading collections…</p> : groupError ? <button className="object-group-retry" onClick={() => void loadNamespaceObjects(namespace, true)}>Couldn’t load collections · Retry</button> : items.length ? items.map((item) => <button className={objectKey(item) === objectName ? "active" : ""} key={objectKey(item)} onClick={() => selectObject(item)} onDoubleClick={() => selectObject(item, true)}><span className={`object-kind-icon ${item.kind}`} aria-hidden="true">{item.kind === "collection" ? "" : item.kind === "view" ? "◇" : "▦"}</span><span className="object-row-name">{item.name}</span><span className="object-row-count" title={item.estimatedRows == null ? "Estimate unavailable" : `${item.estimatedRows.toLocaleString()} estimated ${item.kind === "collection" ? "documents" : "rows"}`}>{item.estimatedRows == null ? "—" : formatCompactCount(item.estimatedRows)}</span></button>) : <p className="object-group-state">No collections</p>}</div>}</section>; })}{!loading && !objectGroups.length && <p className="empty-copy">No accessible objects.</p>}</aside>
        <div className="sidebar-resize-handle" role="separator" aria-label="Resize database sidebar" aria-orientation="vertical" aria-valuemin={190} aria-valuemax={320} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={startSidebarResize} onKeyDown={(event) => { const delta = event.key === "ArrowLeft" ? -8 : event.key === "ArrowRight" ? 8 : 0; if (!delta) return; event.preventDefault(); const width = clampSidebarWidth(sidebarWidth + delta); setSidebarWidth(width); localStorage.setItem("orbit.sidebarWidth", String(width)); }} onDoubleClick={() => { setSidebarWidth(224); localStorage.setItem("orbit.sidebarWidth", "224"); }} />
        <div className="data-grid-wrap">{exploreTabs.length > 0 && <div className="explore-tabs-bar"><div className="explore-tabs-list" role="tablist" aria-label="Open data objects">{exploreTabs.map((tab, index) => <div className={`explore-tab${tab.id === activeExploreTabId ? " active" : ""}${tab.preview ? " preview" : ""}`} role="tab" aria-selected={tab.id === activeExploreTabId} tabIndex={tab.id === activeExploreTabId ? 0 : -1} title={`${tab.connectionName} · ${tab.namespace}.${tab.object}${tab.preview ? " · Preview" : ""}`} key={tab.id} onClick={() => activateExploreTab(tab)} onDoubleClick={() => promoteExploreWorkspaceTab(tab.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateExploreTab(tab); } }}><span className={`explore-tab-kind ${tab.databaseKind}`}>{icon(tab.databaseKind)}</span><span className="explore-tab-copy"><strong>{tab.object}</strong><small>{tab.connectionName} · {tab.namespace}</small></span>{tab.preview && <button className="explore-tab-pin" onClick={(event) => { event.stopPropagation(); promoteExploreWorkspaceTab(tab.id); }} title="Keep tab open" aria-label={`Keep ${tab.object} tab open`}>◇</button>}<button className="explore-tab-close" onClick={(event) => { event.stopPropagation(); closeExploreWorkspaceTab(tab.id); }} title={`Close ${tab.object} · ⌘W`} aria-label={`Close ${tab.object}`}>×</button>{index < 9 && <kbd>{index + 1}</kbd>}</div>)}</div>{exploreTabs.length > 6 && <details className="explore-tabs-overflow" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}><summary title="All open tabs">⌄ <span>{exploreTabs.length}</span></summary><div>{exploreTabs.map((tab) => <button className={tab.id === activeExploreTabId ? "active" : ""} key={tab.id} onClick={(event) => { activateExploreTab(tab); event.currentTarget.closest("details")?.removeAttribute("open"); }}><span>{tab.databaseKind === "mongodb" ? "●" : "▦"}</span><span><strong>{tab.object}</strong><small>{tab.connectionName} · {tab.namespace}</small></span>{tab.preview && <em>Preview</em>}</button>)}</div></details>}</div>}<div className="grid-title"><div className="dataset-breadcrumb"><span>{selectedObject?.namespace ?? connection?.name ?? "Orbit"}</span><b>/</b><strong>{selectedObject?.name ?? (connection ? "Select an object" : "Add a database connection")}</strong></div>{selectedObject && <span>{objectTotal == null ? "Count unavailable" : `${objectTotalApproximate ? "~" : ""}${objectTotal.toLocaleString()} ${objectNoun}`} · {result?.columns.length ?? "—"} {connection?.kind === "mongodb" ? "fields" : "columns"}</span>}<button className={`icon-button${refreshingSchema ? " refreshing" : ""}`} disabled={!connectionId || refreshingSchema} onClick={() => void refreshObjectSchema()} title="Refresh schema" aria-label="Refresh schema"><AppIcon name="refresh" size={14} /></button>{transportMode === "gateway" && selectedObject && <details className="toolbar-menu dataset-actions" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}><summary aria-label="Dataset actions" title="Dataset actions">•••</summary><div><button onClick={() => { setSaveName(selectedObject.name); setSaveDialog("explore"); }}>▥ Save as view</button><button onClick={() => setSection("ask")}>✦ Ask about this data</button></div></details>}</div>
          <div className="grid-tools"><ExploreQueryControls columns={result?.columns ?? []} filters={filters} sort={sort} mongo={connection?.kind === "mongodb"} onFiltersChange={setFilters} onSortChange={setSort} /><button onClick={() => setHidden(new Set())}><AppIcon name="columns" /> {hidden.size ? `${hidden.size} hidden` : "Columns"}</button>{selectedGridRange.cellCount > 1 && <button disabled={!visibleRows.length || !visibleColumns.length} onClick={() => void copyGridSelection()} title="Copy selection · ⌘C"><AppIcon name="copy" /> {gridCopyNotice || `Copy ${selectedGridLabel}`}</button>}<span className="grid-tools-spacer" /><label className="loaded-row-search"><span>⌕</span><input aria-label="Search loaded rows" placeholder="Search loaded rows" value={rowSearch} onChange={(event) => { setRowSearch(event.target.value); updateUrl(connectionId, objectName, event.target.value); }} /></label><details className="toolbar-menu export-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}><summary><AppIcon name="download" size={13} /> Export</summary><div><button onClick={() => exportRows("csv")}>Export CSV</button><button onClick={() => exportRows("json")}>Export JSON</button></div></details></div>
          {!connection ? <div className="no-connections-state"><span className="empty-db-mark">◎</span><h2>Connect your first database</h2><p>Add a local MongoDB connection to browse collections and inspect documents without routing credentials through a server.</p><button className="primary" onClick={() => { setManaging(true); openCreate(); }}>＋ Add database connection</button><small>Credentials are stored in your operating system keychain.</small></div> : error ? <div className="status-state error"><strong>{error.code === "QUERY_TIMEOUT" ? "Query timed out" : error.code === "UNAUTHORIZED" ? "Permission denied" : "Couldn’t load data"}</strong><p>{error.message}</p>{error.requestId && <code>Request {error.requestId}</code>}<button onClick={() => loadRows()}>Try again</button></div> : loading ? <div className="status-state"><span className="spinner" /><strong>Loading live data…</strong></div> : !selectedObject ? <div className="status-state"><strong>Select a table or collection</strong><p>Choose an object from the sidebar or reopen one from Command-K.</p></div> : !result?.rows.length ? <div className="status-state"><strong>No records found</strong><p>This object is empty or your filters match no rows.</p></div> : <div className="table-scroll" ref={tableScrollElement} onScroll={(event) => { if (activeExploreTabIdRef.current) exploreScrollPositions.current[activeExploreTabIdRef.current] = { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; }}><table role="grid" aria-label={`${selectedObject?.name ?? "Data"} records`} aria-rowcount={visibleRows.length} aria-colcount={visibleColumns.length}><thead><tr>{visibleColumns.map((column) => { const isPinned = pinned.has(column.name); const activeSort = sort[0]?.column === column.name ? sort[0] : undefined; const statusColumn = Boolean(column.enumValues?.length) || /status|state/i.test(column.name); const stickyStyle = isPinned ? ({ "--pin-left": `${pinOffsets[column.name] ?? 0}px` } as CSSProperties) : undefined; return <th className={`${isPinned ? "pinned-column " : ""}${activeSort ? "sorted-column " : ""}${statusColumn ? "status-column" : ""}`} style={stickyStyle} ref={(element) => { if (element) headerCells.current.set(column.name, element); else headerCells.current.delete(column.name); }} key={column.name}><div className="column-header"><button className="column-header-label" onClick={() => toggleSort(column.name)} title={`Sort by ${column.name}`}><span>{column.name}{activeSort && <b>{activeSort.direction === "asc" ? "↑" : "↓"}</b>}</span><small>{column.nativeType}</small></button><div className="column-header-actions"><button className={isPinned ? "active" : ""} onClick={() => togglePin(column.name)} title={isPinned ? `Unpin ${column.name}` : `Pin ${column.name}`} aria-label={isPinned ? `Unpin ${column.name}` : `Pin ${column.name}`}><AppIcon name="pin" size={13} /></button><button className={activeSort ? "active" : ""} onClick={() => toggleSort(column.name)} title={activeSort?.direction === "asc" ? "Sort descending" : activeSort?.direction === "desc" ? "Clear sort" : `Sort ${column.name}`} aria-label={`Sort ${column.name}`}><AppIcon name="sort" size={13} /></button><button onClick={() => hideColumn(column.name)} title={`Hide ${column.name}`} aria-label={`Hide ${column.name}`}><AppIcon name="close" size={13} /></button></div></div></th>; })}</tr></thead><tbody>{visibleRows.map((row, rowIndex) => <tr key={rowIndex}>{visibleColumns.map((column, columnIndex) => { const cell = { row: rowIndex, column: columnIndex }; const selected = gridCellSelected(cell, selectedGridRange); const active = gridActive.row === rowIndex && gridActive.column === columnIndex; const isPinned = pinned.has(column.name); const statusColumn = Boolean(column.enumValues?.length) || /status|state/i.test(column.name); const stickyStyle = isPinned ? ({ "--pin-left": `${pinOffsets[column.name] ?? 0}px` } as CSSProperties) : undefined; const canResolve = (connection.kind === "mongodb" && column.name !== "_id") || (connection.kind === "postgres" && Boolean(column.reference) && row[column.name] !== null && row[column.name] !== undefined); return <td className={`${column.primaryKey ? "mono " : ""}grid-cell${isPinned ? " pinned-column" : ""}${selected ? " grid-selected" : ""}${active ? " grid-active" : ""}${statusColumn ? " status-column" : ""}`} style={stickyStyle} key={column.name} role="gridcell" aria-selected={selected} tabIndex={active ? 0 : -1} data-grid-cell={`${rowIndex}-${columnIndex}`} onClick={(event) => { event.stopPropagation(); selectGridCell(cell, event.shiftKey); }} onDoubleClick={() => openRow(row)} onKeyDown={(event) => handleGridKeyDown(event, rowIndex, columnIndex, row)}><DataValue fieldName={column.name} nativeType={column.nativeType} reference={column.reference} enumValues={column.enumValues} value={row[column.name]} mongo={connection.kind === "mongodb"} postgres={connection.kind === "postgres"} onReference={canResolve ? () => openCellReference(row, column.name, row[column.name], column.reference) : undefined} /></td>; })}</tr>)}</tbody></table></div>}
          {result && <footer className="pagination"><span title={documentCount?.error}>{pageSummary}{filters.length ? ` · ${filters.length} filter${filters.length === 1 ? "" : "s"}` : ""}</span>{visibleRows.length > 0 && <small className="grid-keyboard-hint" title="Arrow keys move the active cell. Shift + arrows extends the selection. ⌘/Ctrl + C copies it. ⌘/Ctrl + Shift + C includes headers.">{selectedGridLabel} selected</small>}<button disabled={!cursors.length} onClick={() => { const previous = cursors.slice(0, -1); setCursors(previous); loadRows(previous.at(-1)); }}>← Previous</button><button disabled={!result.nextCursor} onClick={() => { if (!result.nextCursor) return; setCursors((current) => [...current, result.nextCursor!]); loadRows(result.nextCursor); }}>Next →</button></footer>}
        </div></div></section>}
      {section === "ask" && <section className="ask-workflow">
        <header className="section-header"><div><h1>Ask AI</h1><p>Write, review, and run read-only queries with an agent.</p></div><div className="ask-header-meta">{connection && <span className="ask-connection-chip">{connection.name} · {connection.kind}</span>}<span className={`environment-pill ${connection?.environment}`}>{connection?.environment}</span></div></header>
        <AskWorkspace connection={connection} context={selectedObject} question={question} state={askState} trace={askTrace} error={askError ? { code: askError.code, message: askError.message, ...(askError.requestId ? { requestId: askError.requestId } : {}) } : undefined} draft={askDraft} result={askResult} onQuestionChange={setQuestion} onGenerate={generateAskDraft} onQueryChange={(query) => { if (!askDraft) return; setAskDraft({ ...askDraft, query }); setAskResult(undefined); setAskState("ready"); }} onExecute={() => void executeAskDraft()} onDiscard={resetAsk} onNewQuestion={resetAsk} onOpenExplore={() => { const source = askResult?.sourceObjects[0]; if (source) { selectObject(source); setSection("explore"); } }} onSave={() => { setSaveName(question.slice(0, 60) || "AI answer"); setSaveDialog("ask"); }} />
      </section>}
      {section === "views" && <section className="views-dashboard"><header className="section-header"><div><h1>Views</h1><p>Saved tables, answers, and visualizations.</p></div><div className="header-actions"><button className="secondary" onClick={() => Promise.all(views.map(refreshSavedView))}>↻ Refresh all</button><button className="primary" onClick={() => setSection("explore")}>＋ Save from Explore</button></div></header>{viewError && <div className={`view-notice ${viewError.includes("copied") ? "success" : ""}`}>{viewError}</div>}{!views.length ? <div className="status-state"><strong>No saved views yet</strong><p>Save a table from Explore or an answer from Ask to build this dashboard.</p><button onClick={() => setSection("explore")}>Explore data</button></div> : <div className="dashboard-grid">{views.map((view) => { const preview = viewResults[view.id]; const firstValue = preview?.rows[0] ? Object.values(preview.rows[0])[0] : undefined; return <article className={`dashboard-card ${view.status}`} style={{ gridColumn: `${view.layout.x + 1} / span ${view.layout.width}`, gridRow: `span ${view.layout.height}` }} key={view.id}><header><div><small>{view.component.toUpperCase()}</small><h2>{view.name}</h2></div><span className={`view-status ${view.status}`}>{refreshingView === view.id ? "refreshing" : view.status.replace("_", " ")}</span></header><div className="dashboard-preview">{preview ? view.component === "metric" ? <strong className="metric-value">{display(firstValue)}</strong> : view.component === "table" ? <table><thead><tr>{preview.columns.slice(0, 4).map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 4).map((row, index) => <tr key={index}>{preview.columns.slice(0, 4).map((column) => <td key={column.name}>{display(row[column.name])}</td>)}</tr>)}</tbody></table> : <LazyResultChart columns={preview.columns} rows={preview.rows} visualization={view.visualization} compact /> : <div className="view-placeholder"><span>{view.status === "failed" ? "!" : "↻"}</span><p>{view.lastError ?? "Refresh to load this view."}</p></div>}</div><footer><span>{view.lastRefreshedAt ? `Updated ${new Date(view.lastRefreshedAt).toLocaleString()}` : "Never refreshed"}</span><button onClick={() => refreshSavedView(view)} disabled={refreshingView === view.id}>↻</button><button onClick={() => renameSavedView(view)}>Rename</button><button onClick={() => duplicateSavedView(view)}>Duplicate</button><button onClick={() => shareSavedView(view)}>{view.shared ? "Unshare" : "Share"}</button><button className="danger-button" onClick={() => deleteSavedView(view)}>Delete</button></footer></article>; })}</div>}</section>}
    </main>
    <CommandPalette open={commandOpen} commands={commandItems} onClose={() => setCommandOpen(false)} />
    {saveDialog && <div className="modal-backdrop"><form className="save-view-dialog" onSubmit={saveCurrentView}><header><div><small>SAVE TO VIEWS</small><h2>{saveDialog === "ask" ? "Save answer" : "Save table"}</h2></div><button type="button" onClick={() => setSaveDialog(undefined)}>×</button></header>{viewError && <div className="form-error">{viewError}</div>}<label>Name<input autoFocus required value={saveName} onChange={(event) => setSaveName(event.target.value)} /></label><div className="save-summary"><span>{saveDialog === "ask" ? askResult?.visualization?.kind ?? "table" : "table"}</span><div><strong>{connection?.name}</strong><small>{saveDialog === "ask" ? "Generated query and visualization" : `${selectedObject?.namespace}.${selectedObject?.name}`}</small></div></div><footer><button type="button" onClick={() => setSaveDialog(undefined)}>Cancel</button><button className="primary" disabled={savingView}>{savingView ? "Saving…" : "Save view"}</button></footer></form></div>}
    {selectedRow && selectedObject && <RecordInspector baseDocument={selectedRow} baseDatabase={selectedObject.namespace} baseCollection={selectedObject.name} columns={result?.columns ?? []} trail={referenceTrail} lookup={referenceLookup} mongo={connection?.kind === "mongodb"} postgres={connection?.kind === "postgres"} onResolve={openNestedReference} onSearchAll={searchAllReferenceCollections} onChoose={chooseLinkedDocument} onBack={() => { setReferenceTrail((current) => current.slice(0, -1)); setReferenceLookup(undefined); }} onClose={closeInspector} />}
    {managing && <div className="modal-backdrop"><section className="connection-manager" aria-label="Connection manager">
      <header><div><small>{transportMode === "local" ? "LOCAL CONNECTIONS" : "WORKSPACE CONNECTIONS"}</small><h2>{formOpen ? editing ? "Edit connection" : "Add connection" : "Connections"}</h2></div><button onClick={() => formOpen ? setFormOpen(false) : setManaging(false)}>×</button></header>
      {managerError && <div className="form-error">{managerError}</div>}
      {formOpen ? <form onSubmit={saveConnection}>
        {!editing && <label className="database-kind-field">Database<select autoFocus value={connectionForm.kind} onChange={(event) => { const kind = event.target.value as DatabaseKind; setConnectionForm({ ...emptyConnection(), kind, port: defaultPort(kind) }); setConnectionString(defaultConnectionString(kind)); }}><option value="mongodb">MongoDB</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select><small>Choose the database engine before entering connection details.</small></label>}
        <div className="form-row"><label>Connection name<input required value={connectionForm.name} placeholder="Production analytics" onChange={(event) => setConnectionForm({ ...connectionForm, name: event.target.value })} /></label><label>Environment<select value={connectionForm.environment} onChange={(event) => setConnectionForm({ ...connectionForm, environment: event.target.value as ConnectionEnvironment })}><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label></div>
        {!editing && connectionForm.kind !== "mysql" && <label>Connection string<input required type="password" autoComplete="off" spellCheck={false} value={connectionString} placeholder={connectionForm.kind === "postgres" ? "postgresql://user:password@host:5432/database?sslmode=require" : "mongodb+srv://user:password@cluster.example.net"} onChange={(event) => setConnectionString(event.target.value)} /><small>{connectionForm.kind === "postgres" ? "Include the database name in the URL. Provider-specific SSL parameters are preserved." : "Orbit will discover every database and collection this account can access."}</small></label>}
        {!editing && connectionForm.kind === "mysql" && <><div className="form-row"><label>Host<input required value={connectionForm.host} onChange={(event) => setConnectionForm({ ...connectionForm, host: event.target.value })} /></label><label>Port<input required type="number" value={connectionForm.port} onChange={(event) => setConnectionForm({ ...connectionForm, port: Number(event.target.value) })} /></label></div><label>Database<input required value={connectionForm.database} onChange={(event) => setConnectionForm({ ...connectionForm, database: event.target.value })} /></label><div className="form-row"><label>Username<input required autoComplete="username" value={connectionForm.username} onChange={(event) => setConnectionForm({ ...connectionForm, username: event.target.value })} /></label><label>Password<input required type="password" autoComplete="new-password" value={connectionForm.password} onChange={(event) => setConnectionForm({ ...connectionForm, password: event.target.value })} /></label></div><label className="checkbox"><input type="checkbox" checked={connectionForm.tls} onChange={(event) => setConnectionForm({ ...connectionForm, tls: event.target.checked })} /> Require TLS</label></>}
        <footer><button type="button" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Testing connection…" : editing ? "Save changes" : "Test & connect"}</button></footer>
      </form> : <><div className="managed-list">{connections.map((item) => <article key={item.id}><span className={`db-icon ${item.kind}`}>{icon(item.kind)}</span><div><strong>{item.name}</strong><small>{item.kind} · {item.environment} · {item.database}</small><small>{item.status} · {item.latencyMs ?? "—"} ms{item.lastSchemaRefresh ? ` · refreshed ${new Date(item.lastSchemaRefresh).toLocaleString()}` : ""}</small></div><button disabled={testingId === item.id} onClick={() => testManagedConnection(item.id)}>{testingId === item.id ? "Testing…" : "Test"}</button><button disabled={item.demo} onClick={() => openEdit(item)}>Edit</button><button className="danger-button" disabled={item.demo} onClick={() => removeManagedConnection(item)}>Remove</button></article>)}</div><footer><button className="primary" onClick={openCreate}>＋ Add connection</button></footer></>}
    </section></div>}
  </div>;
}
