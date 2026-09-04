import { describe, expect, it } from "vitest";
import { parseSidebarPins, sidebarMatches, sidebarPinKey } from "./sidebar";

describe("sidebar navigation helpers", () => {
  it("matches qualified and fuzzy object names", () => {
    expect(sidebarMatches("production.users", "production", "users")).toBe(true);
    expect(sidebarMatches("prd usr", "production", "users")).toBe(true);
    expect(sidebarMatches("events", "production", "users")).toBe(false);
  });

  it("builds stable keys for pinned objects", () => {
    expect(sidebarPinKey({ namespace: "public", name: "users" })).toBe("public.users");
  });

  it("ignores malformed persisted pins", () => {
    expect(parseSidebarPins(JSON.stringify([
      { namespace: "public", name: "users", kind: "table", estimatedRows: 12 },
      { namespace: "public", kind: "table" },
      { namespace: "public", name: "bad", kind: "function" },
    ]))).toEqual([{ namespace: "public", name: "users", kind: "table", estimatedRows: 12 }]);
    expect(parseSidebarPins("not json")).toEqual([]);
  });
});
