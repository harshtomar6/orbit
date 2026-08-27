import { describe, expect, it } from "vitest";
import { formatPostgresValue } from "./postgres-format";

describe("formatPostgresValue", () => {
  it("formats foreign keys with their exact schema target", () => {
    expect(formatPostgresValue("74ef", "uuid", { namespace: "auth", object: "users", column: "id" })).toMatchObject({ tag: "FK", text: "74ef", target: "auth.users.id", tone: "reference" });
  });

  it("formats native temporal and identifier values", () => {
    expect(formatPostgresValue("2026-08-23", "date")?.tag).toBe("DATE");
    expect(formatPostgresValue("2026-08-23T10:00:00Z", "timestamp with time zone")?.tag).toBe("TIMESTAMPTZ");
    expect(formatPostgresValue("550e8400-e29b-41d4-a716-446655440000", "uuid")?.tone).toBe("id");
  });

  it("summarizes structured and specialized types", () => {
    expect(formatPostgresValue({ enabled: true }, "jsonb")).toMatchObject({ tag: "JSONB", text: "object · 1 fields" });
    expect(formatPostgresValue(["admin", "editor"], "text[]")?.text).toBe("2 items");
    expect(formatPostgresValue("10.2500", "numeric(12,4)")?.tone).toBe("number");
    expect(formatPostgresValue("10.0.0.0/24", "cidr")?.tone).toBe("network");
  });
});
