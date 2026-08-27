export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";
export type EnumTone = StatusTone | "enum-violet" | "enum-blue" | "enum-teal" | "enum-green" | "enum-amber" | "enum-orange" | "enum-rose";

export type ParsedStatus = {
  label: string;
  normalized: string;
  tone: StatusTone;
};

const semanticStatePrefixes = new Set(["connection", "delivery", "health", "job", "lifecycle", "order", "payment", "run", "sync", "task", "workflow"]);

const tones: Record<StatusTone, Set<string>> = {
  success: new Set(["active", "approved", "available", "complete", "completed", "connected", "delivered", "enabled", "healthy", "online", "paid", "resolved", "success", "succeeded", "verified"]),
  info: new Set(["in_progress", "open", "processing", "running", "scheduled", "started", "syncing"]),
  warning: new Set(["draft", "on_hold", "paused", "pending", "queued", "retrying", "review", "waiting", "warning"]),
  danger: new Set(["blocked", "canceled", "cancelled", "disabled", "disconnected", "error", "expired", "failed", "failure", "offline", "rejected", "unhealthy"]),
  neutral: new Set(["archived", "closed", "deleted", "inactive", "skipped", "unknown"]),
};

const enumPalette: EnumTone[] = ["enum-violet", "enum-blue", "enum-teal", "enum-green", "enum-amber", "enum-orange", "enum-rose"];

function semanticTone(value: string): StatusTone | undefined {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return Object.entries(tones).find(([, values]) => values.has(normalized))?.[0] as StatusTone | undefined;
}

function normalizeFieldName(fieldName: string): string {
  return fieldName.replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/[\s.-]+/g, "_").toLowerCase();
}

export function isStatusField(fieldName: string | undefined): boolean {
  if (!fieldName) return false;
  const normalized = normalizeFieldName(fieldName);
  if (normalized === "status" || normalized === "state" || normalized.endsWith("_status")) return true;
  if (!normalized.endsWith("_state")) return false;
  return semanticStatePrefixes.has(normalized.slice(0, -"_state".length));
}

export function statusTone(value: string): StatusTone {
  return semanticTone(value) ?? "neutral";
}

export function enumTone(value: string, enumValues: string[]): EnumTone {
  const semantic = semanticTone(value);
  if (semantic) return semantic;
  const index = enumValues.indexOf(value);
  return enumPalette[(index < 0 ? 0 : index) % enumPalette.length]!;
}

export function parseStatus(fieldName: string | undefined, value: unknown): ParsedStatus | undefined {
  if (!isStatusField(fieldName) || typeof value !== "string" || !value.trim()) return undefined;
  const label = value.trim();
  const normalized = label.toLowerCase().replace(/[\s-]+/g, "_");
  return { label, normalized, tone: statusTone(label) };
}
