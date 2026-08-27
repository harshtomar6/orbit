import type {
  AskAgentEvent,
  AskRequest,
  AskDraft,
  AskExecuteRequest,
  AskResult,
  ConnectionInput,
  ConnectionUpdate,
  DatabaseConnection,
  DocumentCountRequest,
  DocumentCountResult,
  ExploreRequest,
  ExploreResult,
  ObjectListResult,
  ReferenceLookupRequest,
  ReferenceLookupResult,
  CreateSavedView,
  SavedView,
  SavedViewRefreshResult,
  UpdateSavedView,
  SharedViewResult,
} from "@orbit/contracts";
import { askAgentEventSchema } from "@orbit/contracts";

const gatewayUrl = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:8787";
const apiToken = import.meta.env.VITE_ORBIT_API_TOKEN;

export class ApiRequestError extends Error {
  constructor(message: string, readonly code: string, readonly requestId?: string) { super(message); this.name = "ApiRequestError"; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${gatewayUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}), ...init?.headers,
    },
  });

  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) throw new ApiRequestError("The gateway returned an invalid response.", "INVALID_RESPONSE");
  if (!response.ok || !("data" in payload)) {
    const message = "message" in payload && typeof payload.message === "string" ? payload.message : `Request failed with ${response.status}.`;
    const code = "code" in payload && typeof payload.code === "string" ? payload.code : "REQUEST_FAILED";
    const requestId = "requestId" in payload && typeof payload.requestId === "string" ? payload.requestId : undefined;
    throw new ApiRequestError(message, code, requestId);
  }
  return payload.data as T;
}

async function draftAskStream(input: AskRequest, onEvent: (event: AskAgentEvent) => void): Promise<AskDraft> {
  const response = await fetch(`${gatewayUrl}/api/ask/stream`, { method: "POST", headers: { "Content-Type": "application/json", ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}) }, body: JSON.stringify(input) });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const value = typeof payload === "object" && payload !== null ? payload : {};
    throw new ApiRequestError("message" in value && typeof value.message === "string" ? value.message : `Request failed with ${response.status}.`, "code" in value && typeof value.code === "string" ? value.code : "REQUEST_FAILED", "requestId" in value && typeof value.requestId === "string" ? value.requestId : undefined);
  }
  if (!response.body) throw new ApiRequestError("The gateway did not provide an Ask event stream.", "INVALID_RESPONSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let draft: AskDraft | undefined;
  const consume = (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    const event = askAgentEventSchema.parse(JSON.parse(data));
    onEvent(event);
    if (event.type === "draft") draft = event.draft;
    if (event.type === "error") throw new ApiRequestError(event.message, event.code, event.requestId);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!draft) throw new ApiRequestError("The Ask agent ended before producing a query.", "INCOMPLETE_ASK_STREAM");
  return draft;
}

export const api = {
  connections: () => request<DatabaseConnection[]>("/api/connections"),
  createConnection: (input: ConnectionInput) => request<DatabaseConnection>("/api/connections", { method: "POST", body: JSON.stringify(input) }),
  updateConnection: (id: string, input: ConnectionUpdate) => request<DatabaseConnection>(`/api/connections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  removeConnection: (id: string) => request<{ removed: true }>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  objects: (connectionId: string) => request<ObjectListResult>(`/api/connections/${encodeURIComponent(connectionId)}/objects`),
  objectsInNamespace: (connectionId: string, namespace: string) => request<ObjectListResult>(`/api/connections/${encodeURIComponent(connectionId)}/namespaces/${encodeURIComponent(namespace)}/objects`),
  refreshSchema: (connectionId: string) => request<ObjectListResult>(`/api/connections/${encodeURIComponent(connectionId)}/refresh`, { method: "POST" }),
  testConnection: (connectionId: string) => request<{ status: "healthy"; latencyMs: number }>(`/api/connections/${encodeURIComponent(connectionId)}/test`, { method: "POST" }),
  explore: (input: ExploreRequest) =>
    request<ExploreResult>("/api/explore", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  countDocuments: (input: DocumentCountRequest) =>
    request<DocumentCountResult>("/api/explore/count", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  resolveReference: (input: ReferenceLookupRequest) =>
    request<ReferenceLookupResult>("/api/references/resolve", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  draftAsk: (input: AskRequest) =>
    request<AskDraft>("/api/ask/draft", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  draftAskStream,
  executeAsk: (input: AskExecuteRequest) => request<AskResult>("/api/ask/execute", { method: "POST", body: JSON.stringify(input) }),
  views: () => request<SavedView[]>("/api/views"),
  createView: (input: CreateSavedView) => request<SavedView>("/api/views", { method: "POST", body: JSON.stringify(input) }),
  updateView: (id: string, input: UpdateSavedView) => request<SavedView>(`/api/views/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  removeView: (id: string) => request<{ removed: true }>(`/api/views/${encodeURIComponent(id)}`, { method: "DELETE" }),
  duplicateView: (id: string) => request<SavedView>(`/api/views/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
  refreshView: (id: string) => request<SavedViewRefreshResult>(`/api/views/${encodeURIComponent(id)}/refresh`, { method: "POST" }),
  shareView: (id: string) => request<{ token: string; url: string }>(`/api/views/${encodeURIComponent(id)}/share`, { method: "POST" }),
  revokeViewShare: (id: string) => request<SavedView>(`/api/views/${encodeURIComponent(id)}/share`, { method: "DELETE" }),
  sharedView: (token: string) => request<SharedViewResult>(`/shared/views/${encodeURIComponent(token)}`),
};
