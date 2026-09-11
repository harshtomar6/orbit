import type { DatabaseConnection } from "@orbit/contracts";

export const savedConnectionItems = (connections: DatabaseConnection[]) => connections.filter((item) => !item.ephemeral);

export function initialConnectionSelection(connections: DatabaseConnection[], preferredId?: string) {
  const saved = savedConnectionItems(connections);
  if (!saved.length) return "";
  return preferredId && connections.some((item) => item.id === preferredId) ? preferredId : saved[0]!.id;
}

export function reconciledConnectionSelection(connections: DatabaseConnection[], currentId: string) {
  if (currentId && connections.some((item) => item.id === currentId)) return currentId;
  return savedConnectionItems(connections)[0]?.id ?? "";
}

export function shouldShowLocalOnboarding(connections: DatabaseConnection[], loading: boolean, hasError: boolean, activeConnectionId = "", enteredWithDiscoveredConnection = false) {
  const activelyExploringDiscoveredConnection = enteredWithDiscoveredConnection && connections.some((item) => item.id === activeConnectionId && item.ephemeral);
  return !loading && !hasError && savedConnectionItems(connections).length === 0 && !activelyExploringDiscoveredConnection;
}
