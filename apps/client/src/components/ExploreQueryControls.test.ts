import { describe, expect, it } from "vitest";
import { parseFilterValue } from "./ExploreQueryControls";

describe("parseFilterValue", () => {
  it("converts MongoDB ObjectId and date fields to Extended JSON", () => {
    expect(parseFilterValue("507f1f77bcf86cd799439011", { name: "_id", nativeType: "objectId", nullable: false }, true)).toEqual({ $oid: "507f1f77bcf86cd799439011" });
    expect(parseFilterValue("2026-08-23T00:00:00Z", { name: "createdAt", nativeType: "date", nullable: false }, true)).toEqual({ $date: "2026-08-23T00:00:00Z" });
  });

  it("preserves int64 precision and parses common scalar values", () => {
    expect(parseFilterValue("9223372036854775807", { name: "count", nativeType: "int64", nullable: false }, true)).toEqual({ $numberLong: "9223372036854775807" });
    expect(parseFilterValue("true", undefined, true)).toBe(true);
    expect(parseFilterValue("42", undefined, true)).toBe(42);
  });
});
