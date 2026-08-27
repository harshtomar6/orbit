export type OrbitRuntime = "web" | "desktop";
export type DatabaseTransportMode = "gateway" | "local";

export function getRuntime(): OrbitRuntime {
  return "__TAURI_INTERNALS__" in window ? "desktop" : "web";
}

export interface DatabaseTransport {
  mode: DatabaseTransportMode;
}

export function defaultTransport(): DatabaseTransport {
  return {
    mode: getRuntime() === "desktop" ? "local" : "gateway",
  };
}
