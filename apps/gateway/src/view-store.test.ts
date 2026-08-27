import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileViewStore, MemoryViewStore } from "./view-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const input = { name: "Users", connectionId: "demo_postgres", component: "table" as const, source: { kind: "explore" as const, namespace: "public", object: "users", filters: [], sort: [] }, visualization: { kind: "table" as const } };

describe("view stores", () => {
  it("supports CRUD, duplication, and revocable hashed shares", async () => { const store = new MemoryViewStore(); const view = await store.create(input); expect((await store.update(view.id, { name: "Active users" }))?.name).toBe("Active users"); expect((await store.duplicate(view.id))?.name).toBe("Active users copy"); const shared = await store.share(view.id); expect(shared?.view.shared).toBe(true); expect(await store.findShared(shared?.token ?? "")).toBeTruthy(); await store.revokeShare(view.id); expect(await store.findShared(shared?.token ?? "")).toBeUndefined(); expect(await store.remove(view.id)).toBe(true); });
  it("persists definitions and never persists raw share tokens", async () => { const directory = await mkdtemp(path.join(tmpdir(), "orbit-views-")); directories.push(directory); const store = await FileViewStore.open(directory); const view = await store.create(input); const shared = await store.share(view.id); const contents = await readFile(path.join(directory, "views.json"), "utf8"); expect(contents).not.toContain(shared?.token); const reopened = await FileViewStore.open(directory); expect((await reopened.get(view.id))?.name).toBe("Users"); expect(await reopened.findShared(shared?.token ?? "")).toBeTruthy(); });
});
