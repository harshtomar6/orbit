export type CommandCategory = "navigation" | "connection" | "database" | "object" | "view" | "action";

export interface SearchableCommand {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  category: CommandCategory;
}

const scopeByPrefix: Record<string, CommandCategory[]> = {
  ">": ["action", "navigation"],
  "@": ["connection"],
  "/": ["database", "object"],
  "#": ["view"],
};

export function commandQuery(value: string): { query: string; categories?: CommandCategory[]; prefix?: string } {
  const trimmed = value.trimStart();
  const prefix = trimmed[0];
  const categories = prefix ? scopeByPrefix[prefix] : undefined;
  return { query: categories ? trimmed.slice(1).trim() : trimmed.trim(), ...(categories ? { categories, prefix } : {}) };
}

function subsequenceScore(needle: string, haystack: string): number {
  let position = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found < 0) return -1;
    score += found === previous + 1 ? 5 : 1;
    previous = found;
    position = found + 1;
  }
  return score;
}

function commandScore(command: SearchableCommand, query: string): number {
  if (!query) return 0;
  const label = command.label.toLowerCase();
  const searchable = [command.label, command.description ?? "", ...(command.keywords ?? [])].join(" ").toLowerCase();
  const normalized = query.toLowerCase();
  if (label === normalized) return 1_000;
  if (label.startsWith(normalized)) return 800 - label.length;
  const labelIndex = label.indexOf(normalized);
  if (labelIndex >= 0) return 650 - labelIndex;
  const textIndex = searchable.indexOf(normalized);
  if (textIndex >= 0) return 500 - textIndex;
  return subsequenceScore(normalized, searchable);
}

export function rankCommands<T extends SearchableCommand>(commands: T[], value: string, recentIds: string[] = []): T[] {
  const parsed = commandQuery(value);
  const recent = new Map(recentIds.map((id, index) => [id, recentIds.length - index]));
  return commands
    .filter((command) => !parsed.categories || parsed.categories.includes(command.category))
    .map((command, index) => ({ command, index, score: commandScore(command, parsed.query) }))
    .filter((entry) => !parsed.query || entry.score >= 0)
    .sort((left, right) => right.score - left.score || (recent.get(right.command.id) ?? 0) - (recent.get(left.command.id) ?? 0) || left.index - right.index)
    .map((entry) => entry.command);
}
