import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSavedViewSchema, savedViewSchema, updateSavedViewSchema, type CreateSavedView, type SavedView, type UpdateSavedView } from "@orbit/contracts";
import { z } from "zod";

type ViewRecord = { view: SavedView; shareTokenHash?: string };
export interface ViewStore {
  list(): Promise<SavedView[]>; get(id: string): Promise<SavedView | undefined>; create(input: CreateSavedView): Promise<SavedView>;
  update(id: string, input: UpdateSavedView): Promise<SavedView | undefined>; updateStatus(id: string, patch: Pick<Partial<SavedView>, "status" | "lastRefreshedAt" | "lastError">): Promise<SavedView | undefined>;
  remove(id: string): Promise<boolean>; duplicate(id: string): Promise<SavedView | undefined>; share(id: string): Promise<{ view: SavedView; token: string } | undefined>;
  revokeShare(id: string): Promise<SavedView | undefined>; findShared(token: string): Promise<SavedView | undefined>;
}

const recordSchema = z.object({ view: savedViewSchema, shareTokenHash: z.string().optional() });
const fileSchema = z.object({ views: z.array(recordSchema) });
const tokenHash = (token: string) => createHash("sha256").update(token).digest("base64url");
const nextLayout = (count: number) => ({ x: (count * 4) % 12, y: Math.floor(count / 3) * 4, width: 4, height: 4 });

export class MemoryViewStore implements ViewStore {
  protected readonly records = new Map<string, ViewRecord>();
  async changed() {}
  async list() { return [...this.records.values()].map((record) => record.view).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async get(id: string) { return this.records.get(id)?.view; }
  async create(raw: CreateSavedView) { const input = createSavedViewSchema.parse(raw); const now = new Date().toISOString(); const view = savedViewSchema.parse({ id: `view_${randomUUID()}`, ...input, layout: input.layout ?? nextLayout(this.records.size), refresh: { mode: "manual" }, status: "stale", createdAt: now, updatedAt: now, shared: false }); this.records.set(view.id, { view }); await this.changed(); return view; }
  async update(id: string, raw: UpdateSavedView) { const record = this.records.get(id); if (!record) return undefined; const input = updateSavedViewSchema.parse(raw); const view = savedViewSchema.parse({ ...record.view, ...input, updatedAt: new Date().toISOString() }); this.records.set(id, { ...record, view }); await this.changed(); return view; }
  async updateStatus(id: string, patch: Pick<Partial<SavedView>, "status" | "lastRefreshedAt" | "lastError">) { const record = this.records.get(id); if (!record) return undefined; const values: Record<string, unknown> = { ...record.view, ...patch, updatedAt: new Date().toISOString() }; if (patch.lastError === undefined) delete values.lastError; const view = savedViewSchema.parse(values); this.records.set(id, { ...record, view }); await this.changed(); return view; }
  async remove(id: string) { const removed = this.records.delete(id); if (removed) await this.changed(); return removed; }
  async duplicate(id: string) { const source = this.records.get(id)?.view; if (!source) return undefined; return this.create({ name: `${source.name} copy`, connectionId: source.connectionId, component: source.component, source: source.source, visualization: source.visualization, layout: { ...source.layout, x: (source.layout.x + 1) % 12, y: source.layout.y + 1 } }); }
  async share(id: string) { const record = this.records.get(id); if (!record) return undefined; const token = randomBytes(32).toString("base64url"); const view = savedViewSchema.parse({ ...record.view, shared: true, updatedAt: new Date().toISOString() }); this.records.set(id, { view, shareTokenHash: tokenHash(token) }); await this.changed(); return { view, token }; }
  async revokeShare(id: string) { const record = this.records.get(id); if (!record) return undefined; const view = savedViewSchema.parse({ ...record.view, shared: false, updatedAt: new Date().toISOString() }); this.records.set(id, { view }); await this.changed(); return view; }
  async findShared(token: string) { const hash = tokenHash(token); return [...this.records.values()].find((record) => record.shareTokenHash === hash)?.view; }
}

export class FileViewStore extends MemoryViewStore {
  private constructor(readonly directory: string) { super(); }
  static async open(directory: string) { const store = new FileViewStore(directory); await mkdir(directory, { recursive: true, mode: 0o700 }); try { const parsed = fileSchema.parse(JSON.parse(await readFile(path.join(directory, "views.json"), "utf8"))); for (const record of parsed.views) store.records.set(record.view.id, { view: record.view, ...(record.shareTokenHash ? { shareTokenHash: record.shareTokenHash } : {}) }); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; } return store; }
  override async changed() { const temporary = path.join(this.directory, `views.${randomUUID()}.tmp`); await writeFile(temporary, JSON.stringify({ views: [...this.records.values()] }, null, 2), { mode: 0o600 }); await rename(temporary, path.join(this.directory, "views.json")); }
}

export async function createPersistentViewStore() { return FileViewStore.open(process.env.ORBIT_DATA_DIR ?? path.resolve(process.cwd(), ".orbit-data")); }
