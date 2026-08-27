import { describe, expect, it } from "vitest";
import { orderPinnedColumns, pinnedColumnOffsets } from "./column-pinning";

describe("column pinning", () => {
  const columns = [{ name: "id" }, { name: "email" }, { name: "status" }];

  it("moves pinned columns to the left while preserving their schema order", () => {
    expect(orderPinnedColumns(columns, new Set(["status", "id"])).map((column) => column.name)).toEqual(["id", "status", "email"]);
  });

  it("calculates non-overlapping sticky offsets from measured widths", () => {
    expect(pinnedColumnOffsets(columns, new Set(["id", "email"]), (name) => name === "id" ? 80 : 160)).toEqual({ id: 0, email: 80 });
  });
});
