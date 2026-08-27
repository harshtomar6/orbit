import { describe, expect, it } from "vitest";
import { numericChartValue, prepareChartData } from "./ResultChart";

const columns = [
  { name: "plan", nativeType: "text", nullable: false },
  { name: "users", nativeType: "bigint", nullable: false },
  { name: "revenue", nativeType: "numeric", nullable: false },
];
const rows = [{ plan: "Free", users: { $numberLong: "1200" }, revenue: "420.50" }, { plan: "Pro", users: 340, revenue: "900" }];

describe("result chart preparation", () => {
  it("normalizes database numeric values without changing their labels", () => {
    const result = prepareChartData(columns, rows, { kind: "bar", x: "plan", y: ["users", "revenue"] });
    expect(result).toMatchObject({ valid: true, kind: "bar", xName: "plan", inferred: false });
    if (result.valid) expect(result.data[0]).toMatchObject({ orbitLabel: "Free", orbitValue0: 1200, orbitValue1: 420.5 });
  });

  it("infers chartable fields when the model omits them", () => {
    const result = prepareChartData(columns, rows, { kind: "line" });
    expect(result).toMatchObject({ valid: true, xName: "plan", inferred: true });
  });

  it("falls back instead of drawing misleading nonnumeric data", () => {
    expect(prepareChartData([columns[0]!], [{ plan: "Free" }], { kind: "bar", x: "plan", y: ["plan"] })).toEqual({ valid: false, reason: "A chart needs at least one numeric result column. Showing the evidence table instead." });
  });

  it("requires positive slices for donut charts", () => {
    expect(prepareChartData(columns, [{ plan: "A", users: -2, revenue: 0 }], { kind: "donut", x: "plan", y: ["users"] })).toMatchObject({ valid: false });
  });

  it("understands MongoDB Extended JSON numbers", () => {
    expect(numericChartValue({ $numberDecimal: "19.25" })).toBe(19.25);
  });
});
