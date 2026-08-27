import { describe, expect, it } from "vitest";
import { formatMongoValue, mongoReference } from "./mongo-format";

describe("formatMongoValue", () => {
  it("formats ObjectIds without losing the exact value", () => {
    expect(formatMongoValue({ $oid: "507f1f77bcf86cd799439011" })).toMatchObject({ tag: "$oid", text: "507f1f77bcf86cd799439011", tone: "id" });
  });

  it("recognizes explicit DBRefs", () => {
    const value = { $ref: "users", $id: { $oid: "507f1f77bcf86cd799439011" }, $db: "app" };
    expect(mongoReference(value)).toEqual({ id: "507f1f77bcf86cd799439011", collection: "users", database: "app" });
    expect(formatMongoValue(value)?.tag).toBe("$ref");
  });

  it("formats ISO and canonical Extended JSON dates", () => {
    expect(formatMongoValue({ $date: "2026-08-23T00:00:00.000Z" })?.title).toBe("2026-08-23T00:00:00.000Z");
    expect(formatMongoValue({ $date: { $numberLong: "1787443200000" } })?.tag).toBe("$date");
  });

  it("keeps large numbers as exact strings", () => {
    expect(formatMongoValue({ $numberLong: "9223372036854775807" })).toMatchObject({ tag: "$numberLong", text: "9223372036854775807" });
  });

  it("formats binary values and regular expressions", () => {
    expect(formatMongoValue({ $binary: { base64: "AQID", subType: "00" } })?.text).toBe("AQID · subtype 00");
    expect(formatMongoValue({ $regularExpression: { pattern: "orbit", options: "i" } })?.text).toBe("/orbit/i");
  });
});
