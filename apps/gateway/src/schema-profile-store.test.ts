import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSchemaProfileStore, MemorySchemaProfileStore } from "./schema-profile-store.js";

describe("Mongo schema profile store", () => {
  it("caches profiles by connection, database, and collection", async () => {
    const store = new MemorySchemaProfileStore(); const profile = { connectionId: "conn", namespace: "app", object: "users", columns: [{ name: "profile.role", nativeType: "string", nullable: false, presence: 1, enumValues: ["admin", "member"] }], sampledDocuments: 100, refreshedAt: new Date().toISOString() };
    await store.set(profile);
    expect(await store.get("conn", "app", "users")).toEqual(profile);
    expect(await store.get("conn", "app", "events")).toBeUndefined();
  });

  it("invalidates every profile belonging to a refreshed connection", async () => {
    const store = new MemorySchemaProfileStore(); const base = { columns: [], sampledDocuments: 0, refreshedAt: new Date().toISOString() };
    await store.set({ ...base, connectionId: "a", namespace: "app", object: "users" }); await store.set({ ...base, connectionId: "a", namespace: "app", object: "events" }); await store.set({ ...base, connectionId: "b", namespace: "app", object: "users" });
    expect(await store.invalidateConnection("a")).toBe(2);
    expect(await store.get("a", "app", "users")).toBeUndefined(); expect(await store.get("b", "app", "users")).toBeDefined();
  });

  it("reloads derived profiles after a gateway restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orbit-schema-profile-"));
    try {
      const profile = { connectionId: "conn", namespace: "app", object: "users", columns: [{ name: "status", nativeType: "string", nullable: false, enumValues: ["active", "paused"] }], sampledDocuments: 50, refreshedAt: new Date().toISOString() };
      await (await FileSchemaProfileStore.open(directory)).set(profile);
      expect(await (await FileSchemaProfileStore.open(directory)).get("conn", "app", "users")).toEqual(profile);
    } finally { await rm(directory, { recursive: true }); }
  });
});
