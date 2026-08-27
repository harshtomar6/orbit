import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { connectionInputSchema } from "@orbit/contracts";
import { FileConnectionStore, MemoryConnectionStore } from "./connection-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("connection stores", () => {
  it("creates, updates, resolves, and removes memory records", async () => { const store = new MemoryConnectionStore(); const record = await store.create({ name: "Local", kind: "postgres", environment: "development", host: "localhost", port: 5432, database: "app", username: "reader", password: "secret", tls: false }); expect(await store.resolveSecret(record.secretRef)).toContain("reader:secret@localhost"); expect((await store.update(record.public.id, { name: "Renamed" }))?.public.name).toBe("Renamed"); expect(await store.remove(record.public.id)).toBe(true); await expect(store.resolveSecret(record.secretRef)).rejects.toThrow(); });
  it("preserves PostgreSQL connection strings and derives safe public metadata", async () => { const store = new MemoryConnectionStore(); const input = connectionInputSchema.parse({ name: "Hosted Postgres", kind: "postgres", environment: "production", connectionString: "postgresql://reader:secret@db.example.com:5432/analytics?sslmode=verify-full&application_name=orbit" }); const record = await store.create(input); expect(record.public.database).toBe("analytics"); expect(await store.resolveSecret(record.secretRef)).toBe(input.connectionString); });
  it("rejects a PostgreSQL URI without a database", () => { expect(() => connectionInputSchema.parse({ name: "Invalid", kind: "postgres", environment: "development", connectionString: "postgresql://reader:secret@localhost:5432" })).toThrow(); });
  it("persists ciphertext without plaintext credentials", async () => { const directory = await mkdtemp(path.join(tmpdir(), "orbit-vault-")); directories.push(directory); const key = randomBytes(32); const store = await FileConnectionStore.open(directory, key); const record = await store.create({ name: "Production", kind: "mysql", environment: "production", host: "db.internal", port: 3306, database: "billing", username: "reader", password: "super-secret", tls: true }); const file = await readFile(path.join(directory, "secrets.json"), "utf8"); expect(file).not.toContain("super-secret"); expect(file).not.toContain("reader"); expect(await store.resolveSecret(record.secretRef)).toContain("reader:super-secret@db.internal"); const reopened = await FileConnectionStore.open(directory, key); expect((await reopened.get(record.public.id))?.public.name).toBe("Production"); });
});
