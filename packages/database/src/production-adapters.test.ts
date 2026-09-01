import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { inferredMongoCollections, isMongoSystemCollection, isMongoSystemNamespace, mongoExtendedJson, mongoNativeType, profileMongoDocuments } from "./production-adapters.js";

describe("gateway MongoDB value normalization", () => {
  it("identifies MongoDB system namespaces and collections", () => {
    expect(["admin", "config", "local"].every(isMongoSystemNamespace)).toBe(true);
    expect(isMongoSystemNamespace("app")).toBe(false);
    expect(isMongoSystemCollection("system.keys")).toBe(true);
    expect(isMongoSystemCollection("users")).toBe(false);
  });

  it("preserves BSON identity and date types as Extended JSON", () => {
    const value = mongoExtendedJson({
      _id: new ObjectId("507f1f77bcf86cd799439011"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      count: 42,
    });

    expect(value).toEqual({
      _id: { $oid: "507f1f77bcf86cd799439011" },
      createdAt: { $date: "2026-08-23T00:00:00Z" },
      count: 42,
    });
  });

  it("uses native BSON type names that match desktop mode", () => {
    expect(mongoNativeType(new ObjectId())).toBe("objectId");
    expect(mongoNativeType(new Date())).toBe("date");
    expect(mongoNativeType([1, 2])).toBe("array");
    expect(mongoNativeType({ nested: true })).toBe("document");
  });

  it("infers conventional target collections without scanning everything", () => {
    const available = ["users", "companies", "audit_logs"];
    expect(inferredMongoCollections("userId", available)).toEqual(["users"]);
    expect(inferredMongoCollections("company_id", available)).toEqual(["companies"]);
    expect(inferredMongoCollections("status", available)).toEqual([]);
  });

  it("profiles nested paths, arrays, presence, and low-cardinality enums", () => {
    const documents = Array.from({ length: 10 }, (_, index) => ({ _id: new ObjectId(), status: index < 8 ? "active" : "paused", profile: { address: { city: index % 2 ? "Berlin" : "Delhi" }, email: `user${index}@example.com`, apiToken: index % 2 ? "repeated-secret" : "another-secret" }, roles: index % 2 ? ["admin"] : ["member"], ...(index < 8 ? { settings: { notifications: true } } : {}) }));
    const profile = profileMongoDocuments(documents);
    expect(profile.sampledDocuments).toBe(10);
    expect(profile.columns.find((field) => field.name === "profile.address.city")).toMatchObject({ nativeType: "string", nullable: false, presence: 1 });
    expect(profile.columns.find((field) => field.name === "settings.notifications")).toMatchObject({ nativeType: "boolean", nullable: true, presence: .8 });
    expect(profile.columns.find((field) => field.name === "roles")).toMatchObject({ nativeType: "array<string>", enumValues: ["admin", "member"] });
    expect(profile.columns.find((field) => field.name === "status")?.enumValues).toEqual(["active", "paused"]);
    expect(profile.columns.find((field) => field.name === "profile.email")?.enumValues).toBeUndefined();
    expect(profile.columns.find((field) => field.name === "profile.apiToken")?.enumValues).toBeUndefined();
  });
});
