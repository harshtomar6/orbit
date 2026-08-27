import { describe, expect, it } from "vitest";
import { clampGridCell, gridCellSelected, gridRange, gridSelectionToTsv, moveGridCell } from "./grid-selection";

describe("grid selection", () => {
  it("clamps arrow movement to the available cells", () => {
    expect(moveGridCell({ row: 0, column: 0 }, -1, -1, 3, 2)).toEqual({ row: 0, column: 0 });
    expect(moveGridCell({ row: 1, column: 0 }, 1, 1, 3, 2)).toEqual({ row: 2, column: 1 });
    expect(clampGridCell({ row: 9, column: 9 }, 3, 2)).toEqual({ row: 2, column: 1 });
  });

  it("normalizes a rectangular selection in either direction", () => {
    const range = gridRange({ row: 3, column: 2 }, { row: 1, column: 0 });
    expect(range).toEqual({ top: 1, bottom: 3, left: 0, right: 2, cellCount: 9 });
    expect(gridCellSelected({ row: 2, column: 1 }, range)).toBe(true);
    expect(gridCellSelected({ row: 0, column: 1 }, range)).toBe(false);
  });

  it("copies one cell as its raw value and ranges as spreadsheet-compatible TSV", () => {
    const rows = [{ name: "Ada", note: "one\ntwo" }, { name: "Lin", note: { active: true } }];
    expect(gridSelectionToTsv(rows, ["name", "note"], gridRange({ row: 0, column: 0 }, { row: 0, column: 0 }))).toBe("Ada");
    expect(gridSelectionToTsv(rows, ["name", "note"], gridRange({ row: 0, column: 0 }, { row: 1, column: 1 }), true)).toBe('name\tnote\nAda\t"one\ntwo"\nLin\t"{""active"":true}"');
  });
});
