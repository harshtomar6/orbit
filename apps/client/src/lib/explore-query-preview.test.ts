import { describe, expect, it } from "vitest";
import { buildExploreQueryPreview, mongoFilterPreview } from "./explore-query-preview";

describe("Explore query preview", () => {
  it("preserves repeated MongoDB field conditions with an explicit AND", () => {
    expect(mongoFilterPreview([
      { column: "age", operator: "gt", value: 18 },
      { column: "age", operator: "lt", value: 65 },
    ])).toEqual({ $and: [{ age: { $gt: 18 } }, { age: { $lt: 65 } }] });
  });

  it("escapes contains values as literal regular expressions", () => {
    expect(mongoFilterPreview([{ column: "name", operator: "contains", value: "Ada.*[1]" }]))
      .toEqual({ $and: [{ name: { $regex: "Ada\\.\\*\\[1\\]", $options: "i" } }] });
  });

  it("shows pagination and sorting in the generated driver operation", () => {
    const preview = buildExploreQueryPreview({ databaseKind: "mongodb", namespace: "app", object: "users", filters: [], sort: [{ column: "createdAt", direction: "desc" }], limit: 50, offset: 100 });
    expect(preview.query).toContain('.getCollection("users")');
    expect(preview.query).toContain('"createdAt": -1');
    expect(preview.query).toContain(".skip(100)");
    expect(preview.query).toContain(".limit(51)");
  });

  it("renders Extended JSON as executable mongosh constructors", () => {
    const preview = buildExploreQueryPreview({ databaseKind: "mongodb", namespace: "app", object: "events", filters: [
      { column: "ownerId", operator: "eq", value: { $oid: "507f1f77bcf86cd799439011" } },
      { column: "createdAt", operator: "gt", value: { $date: "2026-09-02T12:00:00Z" } },
    ], sort: [], limit: 50, offset: 0 });
    expect(preview.query).toContain('ObjectId("507f1f77bcf86cd799439011")');
    expect(preview.query).toContain('ISODate("2026-09-02T12:00:00Z")');
  });
});
