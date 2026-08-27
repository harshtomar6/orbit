import { describe, expect, it } from "vitest";
import { commandQuery, rankCommands, type SearchableCommand } from "./command-palette";

const commands: SearchableCommand[] = [
  { id: "refresh", label: "Refresh schema", category: "action" },
  { id: "connection", label: "Production analytics", description: "PostgreSQL connection", category: "connection" },
  { id: "object", label: "users", description: "public.users", category: "object" },
  { id: "view", label: "Active customers", category: "view" },
];

describe("command palette search", () => {
  it("parses category prefixes", () => {
    expect(commandQuery("@ prod")).toMatchObject({ prefix: "@", query: "prod", categories: ["connection"] });
    expect(commandQuery("/users")).toMatchObject({ prefix: "/", query: "users", categories: ["database", "object"] });
  });

  it("supports fuzzy matching across labels and descriptions", () => {
    expect(rankCommands(commands, "pdan")[0]?.id).toBe("connection");
    expect(rankCommands(commands, "public.users")[0]?.id).toBe("object");
  });

  it("limits prefixed results to their category", () => {
    expect(rankCommands(commands, "> refresh").map((item) => item.id)).toEqual(["refresh"]);
    expect(rankCommands(commands, "# active").map((item) => item.id)).toEqual(["view"]);
  });
});
