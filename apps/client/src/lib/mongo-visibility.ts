import type { DataObject } from "@orbit/contracts";

const mongoSystemNamespaces = new Set(["admin", "config", "local"]);

export function isMongoSystemNamespace(namespace: string): boolean {
  return mongoSystemNamespaces.has(namespace.toLowerCase());
}

export function isMongoSystemCollection(collection: string): boolean {
  return collection.toLowerCase().startsWith("system.");
}

export function visibleMongoNamespaces(namespaces: string[]): string[] {
  return namespaces.filter((namespace) => !isMongoSystemNamespace(namespace));
}

export function visibleMongoObjects(objects: DataObject[]): DataObject[] {
  return objects.filter((object) => !isMongoSystemNamespace(object.namespace) && !isMongoSystemCollection(object.name));
}

export function restoreMongoObjectKey(objects: DataObject[], preferred: string): string {
  const selected = objects.find((object) => `${object.namespace}.${object.name}` === preferred || object.name === preferred);
  return selected ? `${selected.namespace}.${selected.name}` : "";
}
