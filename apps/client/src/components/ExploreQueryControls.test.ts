import { describe, expect, it } from "vitest";
import { parseFilterValue } from "./ExploreQueryControls";

describe("parseFilterValue", () => {
  it("converts MongoDB ObjectId and date fields to Extended JSON", () => {
    expect(parseFilterValue("507f1f77bcf86cd799439011", { name: "_id", nativeType: "objectId", nullable: false }, true)).toEqual({ $oid: "507f1f77bcf86cd799439011" });
    expect(parseFilterValue("2026-08-23T00:00:00Z", { name: "createdAt", nativeType: "date", nullable: false }, true)).toEqual({ $date: "2026-08-23T00:00:00Z" });
  });

  it("preserves int64 precision and parses common scalar values", () => {
    expect(parseFilterValue("9223372036854775807", { name: "count", nativeType: "int64", nullable: false }, true)).toEqual({ $numberLong: "9223372036854775807" });
    expect(parseFilterValue("true", { name: "active", nativeType: "boolean", nullable: false }, true)).toBe(true);
    expect(parseFilterValue("42", undefined, false)).toBe(42);
  });

  it("treats contains as trimmed literal text and trims ordinary strings", () => {
    const column = { name: "name", nativeType: "string", nullable: false };
    expect(parseFilterValue("  Ada.*  ", column, true, "contains")).toBe("Ada.*");
    expect(parseFilterValue("  active  ", column, true)).toBe("active");
    expect(parseFilterValue("42", column, true)).toBe("42");
  });

  it("rejects invalid values for known MongoDB types", () => {
    expect(() => parseFilterValue("not-an-id", { name: "_id", nativeType: "objectId", nullable: false }, true)).toThrow("24 hexadecimal");
    expect(() => parseFilterValue("not-a-date", { name: "createdAt", nativeType: "date", nullable: false }, true)).toThrow("valid ISO date");
    expect(() => parseFilterValue("1.5", { name: "count", nativeType: "int64", nullable: false }, true)).toThrow("whole numbers");
    expect(() => parseFilterValue("42", { name: "count", nativeType: "int32", nullable: false }, true, "contains")).toThrow("string fields");
  });

  it("allows null for nullable typed MongoDB fields", () => {
    expect(parseFilterValue("null", { name: "ownerId", nativeType: "objectId", nullable: true }, true)).toBeNull();
  });

  it("defaults unknown MongoDB fields to strings and supports an explicit type override", () => {
    expect(parseFilterValue("6384329", undefined, true)).toBe("6384329");
    expect(parseFilterValue("6384329", { name: "accountId", nativeType: "int32", nullable: false }, true, "eq", "string")).toBe("6384329");
    expect(parseFilterValue("6384329", undefined, true, "eq", "number")).toBe(6384329);
  });
});
