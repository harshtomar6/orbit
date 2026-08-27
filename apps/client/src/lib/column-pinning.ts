export function orderPinnedColumns<T extends { name: string }>(columns: T[], pinned: ReadonlySet<string>): T[] {
  return [...columns.filter((column) => pinned.has(column.name)), ...columns.filter((column) => !pinned.has(column.name))];
}

export function pinnedColumnOffsets<T extends { name: string }>(columns: T[], pinned: ReadonlySet<string>, width: (name: string) => number): Record<string, number> {
  const offsets: Record<string, number> = {};
  let left = 0;
  for (const column of columns) {
    if (!pinned.has(column.name)) continue;
    offsets[column.name] = left;
    left += width(column.name);
  }
  return offsets;
}
