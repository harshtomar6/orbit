export type GridCell = { row: number; column: number };

export type GridRange = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  cellCount: number;
};

export function clampGridCell(cell: GridCell, rowCount: number, columnCount: number): GridCell {
  return {
    row: Math.max(0, Math.min(Math.max(0, rowCount - 1), cell.row)),
    column: Math.max(0, Math.min(Math.max(0, columnCount - 1), cell.column)),
  };
}

export function moveGridCell(cell: GridCell, rowDelta: number, columnDelta: number, rowCount: number, columnCount: number): GridCell {
  return clampGridCell({ row: cell.row + rowDelta, column: cell.column + columnDelta }, rowCount, columnCount);
}

export function gridRange(anchor: GridCell, active: GridCell): GridRange {
  const top = Math.min(anchor.row, active.row);
  const bottom = Math.max(anchor.row, active.row);
  const left = Math.min(anchor.column, active.column);
  const right = Math.max(anchor.column, active.column);
  return { top, bottom, left, right, cellCount: (bottom - top + 1) * (right - left + 1) };
}

export function gridCellSelected(cell: GridCell, range: GridRange): boolean {
  return cell.row >= range.top && cell.row <= range.bottom && cell.column >= range.left && cell.column <= range.right;
}

function rawClipboardValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function tsvValue(value: unknown): string {
  const text = rawClipboardValue(value);
  return /["\t\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function gridSelectionToTsv(rows: Record<string, unknown>[], columns: string[], range: GridRange, includeHeaders = false): string {
  if (!rows.length || !columns.length) return "";
  if (range.cellCount === 1 && !includeHeaders) return rawClipboardValue(rows[range.top]?.[columns[range.left]!] as unknown);
  const selectedColumns = columns.slice(range.left, range.right + 1);
  const lines = rows.slice(range.top, range.bottom + 1).map((row) => selectedColumns.map((column) => tsvValue(row[column])).join("\t"));
  if (includeHeaders) lines.unshift(selectedColumns.map(tsvValue).join("\t"));
  return lines.join("\n");
}
