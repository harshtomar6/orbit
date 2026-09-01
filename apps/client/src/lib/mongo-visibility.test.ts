import type { DataObject } from "@orbit/contracts";
import { describe, expect, it } from "vitest";
import { restoreMongoObjectKey, visibleMongoNamespaces, visibleMongoObjects } from "./mongo-visibility";

describe("MongoDB workspace visibility", () => {
  it("hides MongoDB system databases from the default workspace", () => {
    expect(visibleMongoNamespaces(["admin", "app", "config", "local", "reporting"])).toEqual(["app", "reporting"]);
  });

  it("hides stale cached system collections", () => {
    const object = (namespace: string, name: string): DataObject => ({ connectionId: "mongo", namespace, name, kind: "collection" });
    expect(visibleMongoObjects([
      object("admin", "system.keys"),
      object("app", "system.profile"),
      object("app", "users"),
    ])).toEqual([object("app", "users")]);
  });

  it("restores an explicit collection but never auto-selects the first one", () => {
    const objects: DataObject[] = [{ connectionId: "mongo", namespace: "app", name: "users", kind: "collection" }];
    expect(restoreMongoObjectKey(objects, "app.users")).toBe("app.users");
    expect(restoreMongoObjectKey(objects, "")).toBe("");
    expect(restoreMongoObjectKey(objects, "admin.system.keys")).toBe("");
  });
});
