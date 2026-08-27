import type {
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
} from "@orbit/contracts";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import type { DatabaseTransportMode } from "./runtime";

export interface DatabaseApi {
  connections(): Promise<DatabaseConnection[]>;
  createConnection(input: ConnectionInput): Promise<DatabaseConnection>;
  updateConnection(id: string, input: ConnectionUpdate): Promise<DatabaseConnection>;
  removeConnection(id: string): Promise<{ removed: true }>;
  objects(connectionId: string): Promise<ObjectListResult>;
  objectsInNamespace(connectionId: string, namespace: string): Promise<ObjectListResult>;
  refreshSchema(connectionId: string): Promise<ObjectListResult>;
  testConnection(connectionId: string): Promise<{ status: "healthy"; latencyMs: number }>;
  explore(input: ExploreRequest): Promise<ExploreResult>;
  countDocuments(input: DocumentCountRequest): Promise<DocumentCountResult>;
  resolveReference(input: ReferenceLookupRequest): Promise<ReferenceLookupResult>;
}

const localApi: DatabaseApi = {
  connections: () => invoke("local_list_connections"),
  createConnection: (input) => invoke("local_create_connection", { input }),
  updateConnection: (id, input) => invoke("local_update_connection", { id, input }),
  removeConnection: (id) => invoke("local_remove_connection", { id }),
  objects: (id) => invoke("local_list_objects", { id }),
  objectsInNamespace: (id, namespace) => invoke("local_list_namespace_objects", { id, namespace }),
  refreshSchema: (id) => invoke("local_list_objects", { id }),
  testConnection: (id) => invoke("local_test_connection", { id }),
  explore: (request) => invoke("local_explore", { request }),
  countDocuments: (request) => invoke("local_count_documents", { request }),
  resolveReference: (request) => invoke("local_resolve_reference", { request }),
};

const gatewayApi: DatabaseApi = api;

export function databaseApi(mode: DatabaseTransportMode): DatabaseApi {
  return mode === "local" ? localApi : gatewayApi;
}
