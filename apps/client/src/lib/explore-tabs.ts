import type { DatabaseKind, DataObject, ExploreFilter, ExploreSort } from "@orbit/contracts";

export type ExploreTabWorkspace = {
  filters: ExploreFilter[];
  sort: ExploreSort[];
  cursors: string[];
  hidden: string[];
  pinned: string[];
  rowSearch: string;
};

export type ExploreTab = ExploreTabWorkspace & {
  id: string;
  connectionId: string;
  connectionName: string;
  databaseKind: DatabaseKind;
  namespace: string;
  object: string;
  objectKind: DataObject["kind"];
  preview: boolean;
};

export type ExploreTabTarget = Pick<ExploreTab, "connectionId" | "connectionName" | "databaseKind" | "namespace" | "object" | "objectKind">;

export const emptyExploreTabWorkspace = (): ExploreTabWorkspace => ({ filters: [], sort: [], cursors: [], hidden: [], pinned: [], rowSearch: "" });
export const exploreTabId = (target: Pick<ExploreTabTarget, "connectionId" | "namespace" | "object">) => `${target.connectionId}:${target.namespace}.${target.object}`;

export function openExploreTab(tabs: ExploreTab[], target: ExploreTabTarget, persistent = false): { tabs: ExploreTab[]; activeId: string } {
  const id = exploreTabId(target);
  const existing = tabs.find((tab) => tab.id === id);
  if (existing) {
    return {
      tabs: persistent && existing.preview ? tabs.map((tab) => tab.id === id ? { ...tab, preview: false } : tab) : tabs,
      activeId: id,
    };
  }

  const next: ExploreTab = { id, ...target, ...emptyExploreTabWorkspace(), preview: !persistent };
  const previewIndex = tabs.findIndex((tab) => tab.preview);
  if (previewIndex < 0) return { tabs: [...tabs, next], activeId: id };
  return { tabs: tabs.map((tab, index) => index === previewIndex ? next : tab), activeId: id };
}

export function closeExploreTab(tabs: ExploreTab[], activeId: string, id: string): { tabs: ExploreTab[]; activeId: string } {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { tabs, activeId };
  const nextTabs = tabs.filter((tab) => tab.id !== id);
  if (activeId !== id) return { tabs: nextTabs, activeId };
  return { tabs: nextTabs, activeId: nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? "" };
}

export function cycleExploreTab(tabs: ExploreTab[], activeId: string, direction: -1 | 1): string {
  if (!tabs.length) return "";
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));
  return tabs[(index + direction + tabs.length) % tabs.length]!.id;
}
