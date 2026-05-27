// F01 B03 — sqlite-vec-backed VectorStore.
// See 02-design-r2 §3.1.6 for the schema and §3.1.4 / §3.1.7 for the query
// pipeline contract this adapter participates in.

import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import {
  CorruptedStoreError,
  EmbeddingDriftError,
} from "../errors.js";
import type {
  ChunkMetadata,
  ProviderStamp,
  QueryFilter,
  StoredChunk,
  StoredHit,
} from "../types.js";
import type { VectorStore } from "./index.js";
import { compileFilter, isPreFilterEligible } from "./sql.js";

const POST_FILTER_OVERSHOOT = 4;

// Columns of `chunk` table, in stable order, that map to ChunkMetadata.
const META_COLS = [
  "path", "source", "chunkIndex", "startLine", "endLine",
  "contentHash", "sourceHash", "mtimeMs", "language", "headingPath",
  "symbolName", "symbolKind", "scope", "scopeRef", "role",
  "lifecycleStatus", "createdAt", "supersedes",
] as const;

function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bufferToFloat32(b: Buffer | Uint8Array): Float32Array {
  // Copy: SQLite-owned buffers are short-lived after the row is consumed.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

function rowToMetadata(row: Record<string, unknown>): ChunkMetadata {
  return {
    path: row["path"] as string,
    source: row["source"] as ChunkMetadata["source"],
    chunkIndex: row["chunkIndex"] as number,
    startLine: (row["startLine"] as number | null) ?? undefined,
    endLine: (row["endLine"] as number | null) ?? undefined,
    contentHash: row["contentHash"] as string,
    sourceHash: row["sourceHash"] as string,
    mtimeMs: row["mtimeMs"] as number,
    language: (row["language"] as string | null) ?? undefined,
    headingPath: (row["headingPath"] as string | null) ?? undefined,
    symbolName: (row["symbolName"] as string | null) ?? undefined,
    symbolKind: (row["symbolKind"] as string | null) ?? undefined,
    scope: (row["scope"] as string | null) ?? undefined,
    scopeRef: (row["scopeRef"] as string | null) ?? undefined,
    role: (row["role"] as string | null) ?? undefined,
    lifecycleStatus: (row["lifecycleStatus"] as string | null) ?? undefined,
    createdAt: (row["createdAt"] as number | null) ?? undefined,
    supersedes: (row["supersedes"] as string | null) ?? undefined,
  };
}

export class SqliteVecStore implements VectorStore {
  readonly path: string;
  private db: Database | null = null;
  private _stamp: ProviderStamp | null = null;

  constructor(path: string) {
    this.path = path;
  }

  get stamp(): ProviderStamp {
    if (!this._stamp) throw new Error(`SqliteVecStore not opened: ${this.path}`);
    return this._stamp;
  }

  private get d(): Database {
    if (!this.db) throw new Error(`SqliteVecStore not opened: ${this.path}`);
    return this.db;
  }

  private corruptedSentinelPath(): string {
    return `${this.path}.corrupted`;
  }

  async open(stamp: ProviderStamp): Promise<void> {
    if (existsSync(this.corruptedSentinelPath())) {
      throw new CorruptedStoreError({
        path: this.path,
        reason: ".corrupted sentinel present from a previous open",
      });
    }
    await mkdir(dirname(this.path), { recursive: true });
    const markCorrupted = (reason: string, cause?: unknown): never => {
      try { writeFileSync(this.corruptedSentinelPath(), `${reason}\n`); } catch { /* ignore */ }
      throw new CorruptedStoreError({ path: this.path, reason, cause });
    };
    let db: Database;
    try {
      db = new DatabaseConstructor(this.path);
    } catch (cause) {
      markCorrupted(`cannot open database: ${(cause as Error).message}`, cause);
      return; // unreachable; satisfies TS narrowing
    }
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      sqliteVec.load(db);
    } catch (cause) {
      db.close();
      markCorrupted(`cannot initialise pragmas/extension: ${(cause as Error).message}`, cause);
    }

    // Integrity check before any DDL touches the file.
    try {
      const check = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      const ok = check.length === 1 && check[0]?.integrity_check === "ok";
      if (!ok) {
        db.close();
        markCorrupted(`PRAGMA integrity_check: ${JSON.stringify(check)}`);
      }
    } catch (cause) {
      if (cause instanceof CorruptedStoreError) throw cause;
      try { db.close(); } catch { /* ignore */ }
      markCorrupted(`PRAGMA integrity_check threw: ${(cause as Error).message}`, cause);
    }

    // Read existing meta (if any) to detect drift before touching the schema.
    const existingMeta = readMetaIfPresent(db);
    if (existingMeta) {
      const expected: ProviderStamp = existingMeta;
      if (
        expected.provider !== stamp.provider ||
        expected.model !== stamp.model ||
        expected.dim !== stamp.dim ||
        expected.releaseFingerprint !== stamp.releaseFingerprint
      ) {
        db.close();
        throw new EmbeddingDriftError({ expected, actual: stamp });
      }
    }

    // Create schema. `vec0` `dim` literal substituted from stamp.
    const dim = stamp.dim;
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunk (
        id              TEXT PRIMARY KEY,
        path            TEXT NOT NULL,
        source          TEXT NOT NULL,
        chunkIndex      INTEGER NOT NULL,
        startLine       INTEGER,
        endLine         INTEGER,
        contentHash     TEXT NOT NULL,
        sourceHash      TEXT NOT NULL,
        mtimeMs         INTEGER NOT NULL,
        language        TEXT,
        headingPath     TEXT,
        symbolName      TEXT,
        symbolKind      TEXT,
        scope           TEXT,
        scopeRef        TEXT,
        role            TEXT,
        lifecycleStatus TEXT,
        createdAt       INTEGER,
        supersedes      TEXT,
        text            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunk_path_idx        ON chunk(path);
      CREATE INDEX IF NOT EXISTS chunk_source_idx      ON chunk(source);
      CREATE INDEX IF NOT EXISTS chunk_scope_idx       ON chunk(scope, scopeRef);
      CREATE INDEX IF NOT EXISTS chunk_role_idx        ON chunk(role);
      CREATE INDEX IF NOT EXISTS chunk_language_idx    ON chunk(language);
      CREATE INDEX IF NOT EXISTS chunk_createdAt_idx   ON chunk(createdAt);
      CREATE INDEX IF NOT EXISTS chunk_contentHash_idx ON chunk(contentHash);
      CREATE INDEX IF NOT EXISTS chunk_sourceHash_idx  ON chunk(path, sourceHash);
      CREATE TABLE IF NOT EXISTS embedding_cache (
        key    TEXT PRIMARY KEY,
        vector BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_state (
        path         TEXT PRIMARY KEY,
        sourceHash   TEXT NOT NULL,
        mtimeMs      INTEGER NOT NULL,
        lastIngestAt INTEGER NOT NULL
      );
    `);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunk USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dim}]);`);

    if (!existingMeta) {
      const setMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
      const now = Date.now().toString();
      const tx = db.transaction(() => {
        setMeta.run("provider", stamp.provider);
        setMeta.run("model", stamp.model);
        setMeta.run("dim", String(stamp.dim));
        setMeta.run("releaseFingerprint", stamp.releaseFingerprint);
        setMeta.run("createdAt", now);
        setMeta.run("lastIngestAt", "");
        setMeta.run("secretsDroppedTotal", "0");
      });
      tx();
    }

    this.db = db;
    this._stamp = stamp;
  }

  async upsert(rows: StoredChunk[]): Promise<void> {
    if (rows.length === 0) return;
    const db = this.d;
    const stamp = this.stamp;
    const insertChunk = db.prepare(`
      INSERT INTO chunk (
        id, path, source, chunkIndex, startLine, endLine,
        contentHash, sourceHash, mtimeMs, language, headingPath,
        symbolName, symbolKind, scope, scopeRef, role,
        lifecycleStatus, createdAt, supersedes, text
      ) VALUES (
        @id, @path, @source, @chunkIndex, @startLine, @endLine,
        @contentHash, @sourceHash, @mtimeMs, @language, @headingPath,
        @symbolName, @symbolKind, @scope, @scopeRef, @role,
        @lifecycleStatus, @createdAt, @supersedes, @text
      )
      ON CONFLICT(id) DO UPDATE SET
        path=excluded.path, source=excluded.source, chunkIndex=excluded.chunkIndex,
        startLine=excluded.startLine, endLine=excluded.endLine,
        contentHash=excluded.contentHash, sourceHash=excluded.sourceHash, mtimeMs=excluded.mtimeMs,
        language=excluded.language, headingPath=excluded.headingPath,
        symbolName=excluded.symbolName, symbolKind=excluded.symbolKind,
        scope=excluded.scope, scopeRef=excluded.scopeRef, role=excluded.role,
        lifecycleStatus=excluded.lifecycleStatus, createdAt=excluded.createdAt,
        supersedes=excluded.supersedes, text=excluded.text
    `);
    const deleteVec = db.prepare("DELETE FROM vec_chunk WHERE id = ?");
    const insertVec = db.prepare("INSERT INTO vec_chunk(id, embedding) VALUES (?, ?)");
    const tx = db.transaction((rs: StoredChunk[]) => {
      for (const r of rs) {
        if (r.embedding.length !== stamp.dim) {
          throw new EmbeddingDriftError({
            expected: stamp,
            actual: { ...stamp, dim: r.embedding.length, releaseFingerprint: "<runtime-mismatch>" },
            message: `chunk ${r.id}: embedding dim ${r.embedding.length} does not match store dim ${stamp.dim}`,
          });
        }
        insertChunk.run({
          id: r.id,
          path: r.metadata.path,
          source: r.metadata.source,
          chunkIndex: r.metadata.chunkIndex,
          startLine: r.metadata.startLine ?? null,
          endLine: r.metadata.endLine ?? null,
          contentHash: r.metadata.contentHash,
          sourceHash: r.metadata.sourceHash,
          mtimeMs: r.metadata.mtimeMs,
          language: r.metadata.language ?? null,
          headingPath: r.metadata.headingPath ?? null,
          symbolName: r.metadata.symbolName ?? null,
          symbolKind: r.metadata.symbolKind ?? null,
          scope: r.metadata.scope ?? null,
          scopeRef: r.metadata.scopeRef ?? null,
          role: r.metadata.role ?? null,
          lifecycleStatus: r.metadata.lifecycleStatus ?? null,
          createdAt: r.metadata.createdAt ?? null,
          supersedes: r.metadata.supersedes ?? null,
          text: r.text,
        });
        deleteVec.run(r.id);
        insertVec.run(r.id, toBuffer(r.embedding));
      }
    });
    tx(rows);
  }

  async deleteByFilter(filter: QueryFilter): Promise<number> {
    const db = this.d;
    const c = compileFilter(filter);
    const ids = db.prepare(`SELECT id FROM chunk WHERE ${c.sql}`).all(...c.params) as Array<{ id: string }>;
    if (ids.length === 0) return 0;
    return this.deleteByIds(ids.map((r) => r.id));
  }

  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const db = this.d;
    const delChunk = db.prepare("DELETE FROM chunk WHERE id = ?");
    const delVec = db.prepare("DELETE FROM vec_chunk WHERE id = ?");
    let n = 0;
    const tx = db.transaction((xs: string[]) => {
      for (const id of xs) {
        const r = delChunk.run(id);
        delVec.run(id);
        n += r.changes;
      }
    });
    tx(ids);
    return n;
  }

  async query(
    vector: Float32Array,
    topK: number,
    filter?: QueryFilter,
  ): Promise<StoredHit[]> {
    const db = this.d;
    const stamp = this.stamp;
    if (vector.length !== stamp.dim) {
      throw new EmbeddingDriftError({
        expected: stamp,
        actual: { ...stamp, dim: vector.length, releaseFingerprint: "<runtime-mismatch>" },
        message: `query vector dim ${vector.length} does not match store dim ${stamp.dim}`,
      });
    }
    const usePreFilter = filter !== undefined && isPreFilterEligible(filter);
    const fetchK = filter === undefined || usePreFilter ? topK : topK * POST_FILTER_OVERSHOOT;
    const qBuf = toBuffer(vector);

    let hits: Array<{ id: string; distance: number }>;
    if (usePreFilter && filter !== undefined) {
      const c = compileFilter(filter);
      const sql = `
        SELECT v.id AS id, v.distance AS distance
        FROM vec_chunk v
        WHERE v.embedding MATCH ?
          AND v.id IN (SELECT id FROM chunk WHERE ${c.sql})
        ORDER BY v.distance
        LIMIT ?
      `;
      hits = db.prepare(sql).all(qBuf, ...c.params, fetchK) as Array<{ id: string; distance: number }>;
    } else {
      hits = db.prepare(`
        SELECT id, distance FROM vec_chunk
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(qBuf, fetchK) as Array<{ id: string; distance: number }>;
    }
    if (hits.length === 0) return [];

    // Hydrate metadata + text + apply post-filter if needed.
    const idList = hits.map((h) => h.id);
    const placeholders = idList.map(() => "?").join(", ");
    let where = `id IN (${placeholders})`;
    const params: Array<string | number | null> = [...idList];
    if (filter !== undefined && !usePreFilter) {
      const c = compileFilter(filter);
      where += ` AND ${c.sql}`;
      params.push(...c.params);
    }
    const cols = ["id", "text", ...META_COLS].join(", ");
    const rows = db.prepare(`SELECT ${cols} FROM chunk WHERE ${where}`).all(...params) as Array<Record<string, unknown>>;
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows) byId.set(r["id"] as string, r);

    const out: StoredHit[] = [];
    for (const h of hits) {
      const r = byId.get(h.id);
      if (!r) continue; // post-filter excluded
      out.push({
        id: h.id,
        score: 1 - (h.distance * h.distance) / 2,
        text: r["text"] as string,
        metadata: rowToMetadata(r),
      });
      if (out.length >= topK) break;
    }
    return out;
  }

  async stats(): Promise<{ chunks: number; files: number; bytesOnDisk: number; lastIngestAt: string | null }> {
    const db = this.d;
    const chunks = (db.prepare("SELECT COUNT(*) AS n FROM chunk").get() as { n: number }).n;
    const files = (db.prepare("SELECT COUNT(DISTINCT path) AS n FROM chunk").get() as { n: number }).n;
    const lastIngestRow = db.prepare("SELECT value FROM meta WHERE key = 'lastIngestAt'").get() as
      | { value: string }
      | undefined;
    const lastIngestAt = lastIngestRow && lastIngestRow.value !== "" ? lastIngestRow.value : null;
    let bytesOnDisk = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${this.path}${suffix}`;
      if (existsSync(p)) bytesOnDisk += statSync(p).size;
    }
    return { chunks, files, bytesOnDisk, lastIngestAt };
  }

  async close(): Promise<void> {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }

  async drop(): Promise<void> {
    await this.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${this.path}${suffix}`;
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
    const sentinel = this.corruptedSentinelPath();
    if (existsSync(sentinel)) {
      try { unlinkSync(sentinel); } catch { /* ignore */ }
    }
    this._stamp = null;
  }

  async getCachedEmbedding(key: string): Promise<Float32Array | null> {
    const row = this.d.prepare("SELECT vector FROM embedding_cache WHERE key = ?").get(key) as
      | { vector: Buffer }
      | undefined;
    if (!row) return null;
    return bufferToFloat32(row.vector);
  }

  async putCachedEmbedding(key: string, vector: Float32Array): Promise<void> {
    this.d.prepare(`
      INSERT INTO embedding_cache(key, vector) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET vector = excluded.vector
    `).run(key, toBuffer(vector));
  }

  async getFileState(): Promise<Map<string, { sourceHash: string; mtimeMs: number; lastIngestAt: number }>> {
    const rows = this.d.prepare("SELECT path, sourceHash, mtimeMs, lastIngestAt FROM file_state").all() as Array<{
      path: string; sourceHash: string; mtimeMs: number; lastIngestAt: number;
    }>;
    const m = new Map<string, { sourceHash: string; mtimeMs: number; lastIngestAt: number }>();
    for (const r of rows) m.set(r.path, { sourceHash: r.sourceHash, mtimeMs: r.mtimeMs, lastIngestAt: r.lastIngestAt });
    return m;
  }

  async putFileState(rows: Array<{ path: string; sourceHash: string; mtimeMs: number; lastIngestAt: number }>): Promise<void> {
    if (rows.length === 0) return;
    const stmt = this.d.prepare(`
      INSERT INTO file_state(path, sourceHash, mtimeMs, lastIngestAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        sourceHash=excluded.sourceHash, mtimeMs=excluded.mtimeMs, lastIngestAt=excluded.lastIngestAt
    `);
    const tx = this.d.transaction((xs: typeof rows) => {
      for (const r of xs) stmt.run(r.path, r.sourceHash, r.mtimeMs, r.lastIngestAt);
    });
    tx(rows);
  }

  async deleteFileState(paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const stmt = this.d.prepare("DELETE FROM file_state WHERE path = ?");
    let n = 0;
    const tx = this.d.transaction((xs: string[]) => {
      for (const p of xs) n += stmt.run(p).changes;
    });
    tx(paths);
    return n;
  }

  async bumpSecretsDropped(n: number): Promise<void> {
    if (n === 0) return;
    const cur = (this.d.prepare("SELECT value FROM meta WHERE key = 'secretsDroppedTotal'").get() as
      | { value: string }
      | undefined)?.value ?? "0";
    this.d.prepare("UPDATE meta SET value = ? WHERE key = 'secretsDroppedTotal'").run(String(Number(cur) + n));
  }

  async setLastIngestAt(at: number): Promise<void> {
    this.d.prepare("UPDATE meta SET value = ? WHERE key = 'lastIngestAt'").run(new Date(at).toISOString());
  }
}

function readMetaIfPresent(db: Database): ProviderStamp | null {
  // Treat the absence of the meta table as "fresh database".
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!tableRow) return null;
  const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>;
  if (rows.length === 0) return null;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const provider = map.get("provider");
  const model = map.get("model");
  const dimStr = map.get("dim");
  const releaseFingerprint = map.get("releaseFingerprint");
  if (!provider || !model || !dimStr || !releaseFingerprint) return null;
  return { provider, model, dim: Number(dimStr), releaseFingerprint };
}
