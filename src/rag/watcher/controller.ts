// F01 B12 — Watcher controller.
//
// One `WatcherController` per dataset. Responsibilities:
//   - `arm()`   — dynamically import chokidar, run a reconcile sweep, attach
//                 listeners filtered by build/cache + secret exclusions, and
//                 wire each event into the debouncer.
//   - `disarm()` — close the chokidar instance and drop the pending batch.
//   - `reconcile()` — run a one-shot sweep and route changes through the
//                     dataset's `runIngest` path. Acquires the per-dataset
//                     lock indirectly via `runIngest`.
//
// chokidar is imported via `await import("chokidar")` so datasets with
// `watch: false` never trigger the module load.

import path from "node:path";
import { Debouncer, type DebouncerEvent } from "./debouncer.js";
import { BUILD_CACHE_EXCLUSIONS } from "./exclusions.js";
import { detectFlood, DEFAULT_FLOOD_THRESHOLD } from "./flood.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
import { WatcherUnavailableError } from "../errors.js";
import type { SourceRoot, WatchConfig, IngestInput, IngestReport } from "../types.js";
import type { VectorStore } from "../store/index.js";

type AnyChokidarWatcher = {
  on(event: string, fn: (...args: unknown[]) => void): AnyChokidarWatcher;
  close(): Promise<void>;
  getWatched(): Record<string, string[]>;
};

type ChokidarModule = {
  watch: (
    paths: string | string[],
    options?: Record<string, unknown>,
  ) => AnyChokidarWatcher;
};

export interface WatcherControllerArgs {
  datasetId: string;
  sources: ReadonlyArray<SourceRoot>;
  watch: WatchConfig;
  store: VectorStore;
  /**
   * The caller-supplied ingest runner. Concretely this is a closure over
   * `runIngest({ datasetId, lockfilePath, store, provider, chunker, input })`
   * supplied by `dataset.ts`; the controller knows nothing about providers.
   */
  ingest: (input: IngestInput) => Promise<IngestReport>;
  /** Optional logger; defaults to console.warn for floods, console.info otherwise. */
  log?: (level: "info" | "warn", message: string, extra?: Record<string, unknown>) => void;
  /** Test seam: inject a chokidar module substitute. */
  chokidarOverride?: ChokidarModule;
  /** Test seam: override flood threshold. */
  floodThreshold?: number;
}

export class WatcherController {
  private watcher: AnyChokidarWatcher | null = null;
  private readonly debouncer: Debouncer;
  private readonly floodThreshold: number;
  private readonly log: NonNullable<WatcherControllerArgs["log"]>;
  private armed = false;

  constructor(private readonly args: WatcherControllerArgs) {
    this.floodThreshold = args.floodThreshold ?? DEFAULT_FLOOD_THRESHOLD;
    this.log =
      args.log ??
      ((level, msg, extra) => {
        if (level === "warn") console.warn(`[rag-watcher] ${msg}`, extra ?? "");
      });
    this.debouncer = new Debouncer({
      onFlush: (batch) => {
        void this.processBatch(batch);
      },
    });
  }

  isArmed(): boolean {
    return this.armed;
  }

  async reconcile(): Promise<ReconcileResult> {
    const result = await reconcile(this.args.sources, this.args.store);
    const updates = result.changedPaths.concat(result.removedPaths);
    if (updates.length === 0) return result;
    // Group changed paths by source root for the FS ingest call.
    for (const src of this.args.sources) {
      const root = path.resolve(src.root);
      const relevant = result.changedPaths.filter(
        (p) => p === root || p.startsWith(root + path.sep),
      );
      if (relevant.length === 0) continue;
      // We let the standard fs ingest re-walk this root; the file_state diff
      // inside the pipeline will pick up exactly the changed files.
      await this.args.ingest({
        kind: "fs",
        root,
        include: src.include ?? ["**/*"],
        exclude: [...(src.exclude ?? []), ...BUILD_CACHE_EXCLUSIONS],
      });
    }
    return result;
  }

  async arm(): Promise<void> {
    if (this.args.watch === false) {
      throw new Error(`watch is disabled for dataset ${this.args.datasetId}`);
    }
    if (this.armed) return;
    // Startup sweep BEFORE arming.
    await this.reconcile();

    const chokidar = this.args.chokidarOverride ?? ((await import("chokidar")) as unknown as ChokidarModule);
    const watchPaths = this.args.sources.map((s) => path.resolve(s.root));
    const ignored = [...BUILD_CACHE_EXCLUSIONS];
    const options: Record<string, unknown> = {
      ignored,
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
    };
    if (this.args.watch !== true) {
      options.usePolling = true;
      const interval = this.args.watch.interval;
      if (interval !== undefined) {
        options.interval = interval;
        options.binaryInterval = interval;
      }
    }

    let watcher: AnyChokidarWatcher;
    try {
      watcher = chokidar.watch(watchPaths, options);
    } catch (err) {
      throw new WatcherUnavailableError({
        datasetId: this.args.datasetId,
        sourceCount: this.args.sources.length,
        fileCountApprox: 0,
        cause: err,
      });
    }

    watcher.on("error", (...args: unknown[]) => {
      const err = args[0];
      const code = (err as { code?: string } | undefined)?.code;
      if (code === "ENOSPC") {
        // inotify watch limit reached at arm-time.
        this.armed = false;
        void watcher.close();
        this.log("warn", "inotify watch limit reached", { datasetId: this.args.datasetId });
        // We cannot throw asynchronously here; surface via log.
      }
    });
    watcher.on("add", (...args: unknown[]) => {
      const p = args[0];
      if (typeof p === "string") this.debouncer.push({ kind: "upsert", path: p });
    });
    watcher.on("change", (...args: unknown[]) => {
      const p = args[0];
      if (typeof p === "string") this.debouncer.push({ kind: "upsert", path: p });
    });
    watcher.on("unlink", (...args: unknown[]) => {
      const p = args[0];
      if (typeof p === "string") this.debouncer.push({ kind: "delete", path: p });
    });

    this.watcher = watcher;
    this.armed = true;
  }

  async disarm(): Promise<void> {
    if (!this.armed) return;
    this.debouncer.cancel();
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch {
        /* swallow */
      }
      this.watcher = null;
    }
    this.armed = false;
  }

  private async processBatch(batch: DebouncerEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const flood = detectFlood(batch.map((b) => b.path), this.floodThreshold);
    if (flood) {
      this.log("warn", "watcher batch dropped (flood)", {
        datasetId: this.args.datasetId,
        pathCount: flood.pathCount,
        topDirs: flood.topDirs,
      });
      return;
    }
    // Group paths back into their source roots so the FS ingest picks up the
    // canonical relative paths. Anything outside the configured sources is
    // ignored (the watcher should not see those, but defence in depth).
    const sourceRoots = this.args.sources.map((s) => ({
      ...s,
      absolute: path.resolve(s.root),
    }));
    const byRoot = new Map<typeof sourceRoots[number], DebouncerEvent[]>();
    for (const ev of batch) {
      const hit = sourceRoots.find(
        (sr) => ev.path === sr.absolute || ev.path.startsWith(sr.absolute + path.sep),
      );
      if (!hit) continue;
      let arr = byRoot.get(hit);
      if (!arr) {
        arr = [];
        byRoot.set(hit, arr);
      }
      arr.push(ev);
    }
    for (const [sr] of byRoot) {
      // Delegate to the fs walker; runIngest's diff against file_state ensures
      // only actually-changed files are embedded.
      try {
        await this.args.ingest({
          kind: "fs",
          root: sr.absolute,
          include: sr.include ?? ["**/*"],
          exclude: [...(sr.exclude ?? []), ...BUILD_CACHE_EXCLUSIONS],
        });
      } catch (err) {
        this.log("warn", "watcher ingest failed", {
          datasetId: this.args.datasetId,
          root: sr.absolute,
          error: String(err),
        });
      }
    }
  }
}
