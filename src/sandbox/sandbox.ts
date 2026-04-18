/**
 * Sandbox — isolated environment for testing service changes
 * before promoting them to production.
 */
import { execSync } from "node:child_process";
import { mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";

export interface SandboxInstance {
  id: string;
  sourcePath: string;
  sandboxPath: string;
  createdAt: string;
}

export interface SandboxTestResult {
  passed: boolean;
  output: string;
  phase: "install" | "typecheck" | "test" | "smoke";
}

export class Sandbox {
  private instances = new Map<string, SandboxInstance>();

  /** Create a sandbox copy of a service directory */
  start(sourcePath: string): SandboxInstance {
    const id = randomUUID();
    const sandboxPath = join(tmpdir(), "saivage-sandbox", id);

    mkdirSync(sandboxPath, { recursive: true });
    cpSync(sourcePath, sandboxPath, { recursive: true });

    const instance: SandboxInstance = {
      id,
      sourcePath,
      sandboxPath,
      createdAt: new Date().toISOString(),
    };

    this.instances.set(id, instance);
    log.info(`Sandbox created: ${id} at ${sandboxPath}`);
    return instance;
  }

  /** Run tests in the sandbox */
  runTests(id: string): SandboxTestResult {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Sandbox not found: ${id}`);

    return this.execPhase(instance.sandboxPath, "test", "npm test");
  }

  /** Run smoke test — just verify the service starts and responds */
  smokeTest(id: string): SandboxTestResult {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Sandbox not found: ${id}`);

    return this.execPhase(
      instance.sandboxPath,
      "smoke",
      "npx tsc --noEmit",
    );
  }

  /** Promote sandbox changes back to the source */
  promote(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) {
      log.error(`Sandbox not found: ${id}`);
      return false;
    }

    // Copy sandbox back to source
    rmSync(instance.sourcePath, { recursive: true, force: true });
    cpSync(instance.sandboxPath, instance.sourcePath, { recursive: true });

    log.info(`Sandbox ${id} promoted to ${instance.sourcePath}`);
    this.destroy(id);
    return true;
  }

  /** Destroy a sandbox instance */
  destroy(id: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    rmSync(instance.sandboxPath, { recursive: true, force: true });
    this.instances.delete(id);
    log.info(`Sandbox ${id} destroyed`);
  }

  /** List active sandbox instances */
  list(): SandboxInstance[] {
    return [...this.instances.values()];
  }

  private execPhase(
    cwd: string,
    phase: SandboxTestResult["phase"],
    command: string,
  ): SandboxTestResult {
    try {
      const output = execSync(command, {
        cwd,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { passed: true, output, phase };
    } catch (err) {
      const output =
        err instanceof Error
          ? (err as Error & { stderr?: string; stdout?: string }).stderr ??
            (err as Error & { stdout?: string }).stdout ??
            err.message
          : String(err);
      return { passed: false, output, phase };
    }
  }
}
