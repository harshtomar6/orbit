import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { databaseConnectionSchema, type ConnectionInput, type ConnectionUpdate, type DatabaseConnection } from "@orbit/contracts";
import { z } from "zod";

export interface ConnectionRecord { public: DatabaseConnection; secretRef: string }
export interface ConnectionStore {
  list(): Promise<ConnectionRecord[]>; get(id: string): Promise<ConnectionRecord | undefined>;
  create(input: ConnectionInput): Promise<ConnectionRecord>; update(id: string, input: ConnectionUpdate): Promise<ConnectionRecord | undefined>;
  remove(id: string): Promise<boolean>; updatePublic(id: string, patch: Partial<DatabaseConnection>): Promise<void>;
  resolveSecret(secretRef: string): Promise<string>;
}

const persistedSchema = z.object({ connections: z.array(z.object({ public: databaseConnectionSchema, secretRef: z.string() })) });
const encryptedSchema = z.object({ iv: z.string(), tag: z.string(), ciphertext: z.string() });
type StoredSecret = z.infer<typeof encryptedSchema>;

function uriFor(input: ConnectionInput): string {
  if (input.connectionString && (input.kind === "postgres" || input.kind === "mongodb")) return input.connectionString.trim();
  const auth = `${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}`;
  const host = input.host.includes(":") && !input.host.startsWith("[") ? `[${input.host}]` : input.host;
  if (input.kind === "postgres") return `postgresql://${auth}@${host}:${input.port}/${encodeURIComponent(input.database)}?sslmode=${input.tls ? "require" : "disable"}`;
  if (input.kind === "mysql") return `mysql://${auth}@${host}:${input.port}/${encodeURIComponent(input.database)}${input.tls ? "?ssl=true" : ""}`;
  return `mongodb://${auth}@${host}:${input.port}/${encodeURIComponent(input.database)}${input.tls ? "?tls=true" : ""}`;
}

function databaseFor(input: ConnectionInput): string {
  if (input.kind === "mongodb" && input.connectionString) return "All databases";
  if (input.kind === "postgres" && input.connectionString) return decodeURIComponent(new URL(input.connectionString).pathname.replace(/^\//, ""));
  return input.database;
}

export class MemoryConnectionStore implements ConnectionStore {
  readonly #records = new Map<string, ConnectionRecord>(); readonly #secrets = new Map<string, string>();
  constructor(records: ConnectionRecord[] = []) { for (const record of records) this.#records.set(record.public.id, record); }
  async list() { return [...this.#records.values()]; } async get(id: string) { return this.#records.get(id); }
  async create(input: ConnectionInput) { const id = `conn_${randomUUID()}`; const secretRef = `secret_${randomUUID()}`; const record: ConnectionRecord = { public: { id, name: input.name, kind: input.kind, environment: input.environment, database: databaseFor(input), readOnly: true, accessLevel: "read_only", status: "checking" }, secretRef }; this.#records.set(id, record); this.#secrets.set(secretRef, uriFor(input)); return record; }
  async update(id: string, input: ConnectionUpdate) { const current = this.#records.get(id); if (!current) return undefined; const publicConnection = databaseConnectionSchema.parse({ ...current.public, name: input.name ?? current.public.name, kind: input.kind ?? current.public.kind, environment: input.environment ?? current.public.environment, database: input.database ?? current.public.database, status: "checking" }); const record = { public: publicConnection, secretRef: current.secretRef }; this.#records.set(id, record); if (input.password) { const existingUri = await this.resolveSecret(current.secretRef); const parsed = new URL(existingUri); const complete: ConnectionInput = { name: publicConnection.name, kind: input.kind ?? current.public.kind, environment: publicConnection.environment, host: input.host ?? parsed.hostname, port: input.port ?? Number(parsed.port), database: publicConnection.database, username: input.username ?? decodeURIComponent(parsed.username), password: input.password, tls: input.tls ?? parsed.searchParams.has("sslmode") ? parsed.searchParams.get("sslmode") !== "disable" : parsed.searchParams.get("tls") === "true" || parsed.searchParams.get("ssl") === "true" }; this.#secrets.set(current.secretRef, uriFor(complete)); } return record; }
  async remove(id: string) { const record = this.#records.get(id); if (!record) return false; this.#records.delete(id); this.#secrets.delete(record.secretRef); return true; }
  async updatePublic(id: string, patch: Partial<DatabaseConnection>) { const record = this.#records.get(id); if (record) this.#records.set(id, { ...record, public: databaseConnectionSchema.parse({ ...record.public, ...patch }) }); }
  async resolveSecret(secretRef: string) { const value = this.#secrets.get(secretRef); if (!value) throw new Error("Connection secret is unavailable."); return value; }
}

export class FileConnectionStore implements ConnectionStore {
  readonly #records = new Map<string, ConnectionRecord>(); readonly #secrets = new Map<string, StoredSecret>();
  private constructor(readonly directory: string, readonly key: Buffer) {}
  static async open(directory: string, key: Buffer) { const store = new FileConnectionStore(directory, key); await mkdir(directory, { recursive: true, mode: 0o700 }); await store.load(); return store; }
  async load() { try { const parsed = persistedSchema.parse(JSON.parse(await readFile(path.join(this.directory, "connections.json"), "utf8"))); for (const record of parsed.connections) this.#records.set(record.public.id, record); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; } try { const value: unknown = JSON.parse(await readFile(path.join(this.directory, "secrets.json"), "utf8")); if (typeof value !== "object" || value === null) throw new Error("Invalid secret store."); for (const [ref, secret] of Object.entries(value)) this.#secrets.set(ref, encryptedSchema.parse(secret)); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; } }
  async persist() { const connectionTemp = path.join(this.directory, `connections.${randomUUID()}.tmp`); const secretsTemp = path.join(this.directory, `secrets.${randomUUID()}.tmp`); await writeFile(connectionTemp, JSON.stringify({ connections: [...this.#records.values()] }, null, 2), { mode: 0o600 }); await writeFile(secretsTemp, JSON.stringify(Object.fromEntries(this.#secrets), null, 2), { mode: 0o600 }); await rename(connectionTemp, path.join(this.directory, "connections.json")); await rename(secretsTemp, path.join(this.directory, "secrets.json")); }
  encrypt(value: string): StoredSecret { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }; }
  decrypt(value: StoredSecret): string { const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64")); decipher.setAuthTag(Buffer.from(value.tag, "base64")); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8"); }
  async list() { return [...this.#records.values()]; } async get(id: string) { return this.#records.get(id); }
  async create(input: ConnectionInput) { const id = `conn_${randomUUID()}`; const secretRef = `secret_${randomUUID()}`; const record: ConnectionRecord = { public: { id, name: input.name, kind: input.kind, environment: input.environment, database: databaseFor(input), readOnly: true, accessLevel: "read_only", status: "checking" }, secretRef }; this.#records.set(id, record); this.#secrets.set(secretRef, this.encrypt(uriFor(input))); await this.persist(); return record; }
  async update(id: string, input: ConnectionUpdate) { const current = this.#records.get(id); if (!current) return undefined; const publicConnection = databaseConnectionSchema.parse({ ...current.public, name: input.name ?? current.public.name, kind: input.kind ?? current.public.kind, environment: input.environment ?? current.public.environment, database: input.database ?? current.public.database, status: "checking" }); const record = { public: publicConnection, secretRef: current.secretRef }; this.#records.set(id, record); if (input.password) { const parsed = new URL(await this.resolveSecret(current.secretRef)); const tlsFromUri = parsed.searchParams.get("sslmode") !== "disable" || parsed.searchParams.get("tls") === "true" || parsed.searchParams.get("ssl") === "true"; const complete: ConnectionInput = { name: publicConnection.name, kind: input.kind ?? current.public.kind, environment: publicConnection.environment, host: input.host ?? parsed.hostname, port: input.port ?? Number(parsed.port), database: publicConnection.database, username: input.username ?? decodeURIComponent(parsed.username), password: input.password, tls: input.tls ?? tlsFromUri }; this.#secrets.set(current.secretRef, this.encrypt(uriFor(complete))); } await this.persist(); return record; }
  async remove(id: string) { const record = this.#records.get(id); if (!record) return false; this.#records.delete(id); this.#secrets.delete(record.secretRef); await this.persist(); return true; }
  async updatePublic(id: string, patch: Partial<DatabaseConnection>) { const record = this.#records.get(id); if (!record) return; this.#records.set(id, { ...record, public: databaseConnectionSchema.parse({ ...record.public, ...patch }) }); await this.persist(); }
  async resolveSecret(secretRef: string) { const value = this.#secrets.get(secretRef); if (!value) throw new Error("Connection secret is unavailable."); return this.decrypt(value); }
}

export async function createPersistentConnectionStore() { const directory = process.env.ORBIT_DATA_DIR ?? path.resolve(process.cwd(), ".orbit-data"); const encoded = process.env.ORBIT_ENCRYPTION_KEY; if (process.env.NODE_ENV === "production" && !encoded) throw new Error("ORBIT_ENCRYPTION_KEY is required in production."); let key: Buffer; if (encoded) { key = Buffer.from(encoded, "base64"); if (key.length !== 32) throw new Error("ORBIT_ENCRYPTION_KEY must be 32 bytes encoded as base64."); } else { const keyPath = path.join(directory, "development.key"); await mkdir(directory, { recursive: true, mode: 0o700 }); try { key = Buffer.from(await readFile(keyPath, "utf8"), "base64"); } catch { key = randomBytes(32); await writeFile(keyPath, key.toString("base64"), { mode: 0o600 }); console.warn("Using a local development encryption key. Configure ORBIT_ENCRYPTION_KEY for deployment."); } } return FileConnectionStore.open(directory, key); }
