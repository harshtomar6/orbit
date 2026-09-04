import type { DataObject } from "@orbit/contracts";

export interface SidebarPin {
  namespace: string;
  name: string;
  kind: DataObject["kind"];
  estimatedRows?: number;
}

export function sidebarPinKey(item: Pick<SidebarPin, "namespace" | "name">): string {
  return `${item.namespace}.${item.name}`;
}

function fuzzySubsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (const character of haystack) if (character === needle[cursor]) cursor += 1;
  return cursor === needle.length;
}

export function sidebarMatches(query: string, namespace: string, name: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const qualified = `${namespace}.${name}`.toLowerCase();
  if (qualified.includes(needle)) return true;
  const tokens = needle.split(/\s+/).filter(Boolean);
  return tokens.every((token) => fuzzySubsequence(token, qualified));
}

export function parseSidebarPins(value: string | null): SidebarPin[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SidebarPin => {
      if (!item || typeof item !== "object") return false;
      const pin = item as Record<string, unknown>;
      return typeof pin.namespace === "string" && typeof pin.name === "string" && ["collection", "table", "view"].includes(String(pin.kind)) && (pin.estimatedRows === undefined || typeof pin.estimatedRows === "number");
    });
  } catch {
    return [];
  }
}

