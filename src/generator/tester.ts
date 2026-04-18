/**
 * Test runner for generated services — install, typecheck, test with retry.
 */
import { execSync } from "node:child_process";
import { log } from "../log.js";

export interface TestResult {
  passed: boolean;
  output: string;
  phase: "install" | "typecheck" | "test";
}

/** Run the full validation pipeline for a generated service */
export async function validateService(
  servicePath: string,
  maxRetries = 2,
): Promise<TestResult> {
  // Phase 1: Install dependencies
  const installResult = runPhase(servicePath, "install", "npm install");
  if (!installResult.passed) return installResult;

  // Phase 2: Type-check
  const typecheckResult = runPhase(
    servicePath,
    "typecheck",
    "npx tsc --noEmit",
  );
  if (!typecheckResult.passed) return typecheckResult;

  // Phase 3: Run tests
  const testResult = runPhase(servicePath, "test", "npx vitest run");
  if (!testResult.passed && maxRetries > 0) {
    log.warn(
      `Tests failed for service at ${servicePath}, ${maxRetries} retries left`,
    );
    // Return the failure — the pipeline will attempt to fix via codegen
    return testResult;
  }

  return testResult;
}

function runPhase(
  cwd: string,
  phase: TestResult["phase"],
  command: string,
): TestResult {
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

    log.warn(`Phase "${phase}" failed: ${output.slice(0, 200)}`);
    return { passed: false, output, phase };
  }
}
