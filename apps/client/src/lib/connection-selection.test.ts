import type { DatabaseConnection } from "@orbit/contracts";
import { describe, expect, it } from "vitest";
import { initialConnectionSelection, reconciledConnectionSelection, savedConnectionItems, shouldShowLocalOnboarding } from "./connection-selection";

const connection = (id: string, ephemeral = false): DatabaseConnection => ({
  id,
  name: id,
  kind: "postgres",
  environment: "development",
  database: "app",
  readOnly: true,
  status: "healthy",
  accessLevel: "read_only",
  ...(ephemeral ? {
    ephemeral: true,
    source: { kind: "docker", containerId: id, containerName: id, image: "postgres:17", project: "app", health: "running" },
  } : {}),
});

describe("connection selection", () => {
  it("does not treat auto-discovered Docker databases as saved connections", () => {
    const connections = [connection("docker-db", true)];
    expect(savedConnectionItems(connections)).toEqual([]);
    expect(shouldShowLocalOnboarding(connections, false, false)).toBe(true);
  });

  it("lets the user explicitly explore a temporary connection and returns when it disappears", () => {
    const connections = [connection("docker-db", true)];
    expect(shouldShowLocalOnboarding(connections, false, false, "docker-db", true)).toBe(false);
    expect(shouldShowLocalOnboarding([], false, false, "docker-db", true)).toBe(true);
  });

  it("does not auto-select an unpinned Docker database on first launch", () => {
    expect(initialConnectionSelection([connection("docker-db", true)], "docker-db")).toBe("");
    expect(reconciledConnectionSelection([connection("docker-db", true)], "")).toBe("");
  });

  it("selects saved connections while preserving an explicit valid selection", () => {
    const connections = [connection("saved-db"), connection("docker-db", true)];
    expect(initialConnectionSelection(connections)).toBe("saved-db");
    expect(initialConnectionSelection(connections, "docker-db")).toBe("docker-db");
    expect(reconciledConnectionSelection(connections, "docker-db")).toBe("docker-db");
  });
});
