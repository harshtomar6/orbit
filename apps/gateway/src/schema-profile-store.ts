import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataColumnSchema, type DataColumn } from "@orbit/contracts";
import { z } from "zod";

export interface MongoSchemaProfile {
  connectionId: string;
  namespace: string;
  object: string;
  columns: DataColumn[];
  sampledDocuments: number;
  refreshedAt: string;
}

export interface SchemaProfileStore {
  get(connectionId: string, namespace: string, object: string): Promise<MongoSchemaProfile | undefined>;
  set(profile: MongoSchemaProfile): Promise<void>;
  invalidateConnection(connectionId: string): Promise<number>;
}

const profileSchema = z.object({ connectionId: z.string(), namespace: z.string(), object: z.string(), columns: z.array(dataColumnSchema), sampledDocuments: z.number().int().nonnegative(), refreshedAt: z.string().datetime() });
const fileSchema = z.object({ profiles: z.array(profileSchema) });
const profileKey = (connectionId: string, namespace: string, object: string) => JSON.stringify([connectionId, namespace, object]);

export class MemorySchemaProfileStore implements SchemaProfileStore {
  protected readonly profiles = new Map<string, MongoSchemaProfile>();
  async changed() {}
  async get(connectionId: string, namespace: string, object: string) { return this.profiles.get(profileKey(connectionId, namespace, object)); }
  async set(raw: MongoSchemaProfile) { const profile = profileSchema.parse(raw); this.profiles.set(profileKey(profile.connectionId, profile.namespace, profile.object), profile); await this.changed(); }
  async invalidateConnection(connectionId: string) { let removed = 0; for (const [key, profile] of this.profiles) if (profile.connectionId === connectionId) { this.profiles.delete(key); removed += 1; } if (removed) await this.changed(); return removed; }
}

export class FileSchemaProfileStore extends MemorySchemaProfileStore {
  #pendingWrite = Promise.resolve();
  private constructor(readonly directory: string) { super(); }
  static async open(directory: string) {
    const store = new FileSchemaProfileStore(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
    try { const parsed = fileSchema.parse(JSON.parse(await readFile(path.join(directory, "schema-profiles.json"), "utf8"))); for (const profile of parsed.profiles) store.profiles.set(profileKey(profile.connectionId, profile.namespace, profile.object), profile); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    return store;
  }
  override async changed() {
    this.#pendingWrite = this.#pendingWrite.then(async () => { const temporary = path.join(this.directory, `schema-profiles.${randomUUID()}.tmp`); await writeFile(temporary, JSON.stringify({ profiles: [...this.profiles.values()] }, null, 2), { mode: 0o600 }); await rename(temporary, path.join(this.directory, "schema-profiles.json")); });
    return this.#pendingWrite;
  }
}

export async function createPersistentSchemaProfileStore() { return FileSchemaProfileStore.open(process.env.ORBIT_DATA_DIR ?? path.resolve(process.cwd(), ".orbit-data")); }
