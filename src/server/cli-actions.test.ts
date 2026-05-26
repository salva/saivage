import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, runPlanner } from "./bootstrap.js";
import { withRuntime, type SaivageRuntime } from "./cli-actions.js";

vi.mock("./bootstrap.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./bootstrap.js")>();
  return {
    ...real,
    bootstrap: vi.fn(),
    runPlanner: vi.fn(),
  };
});

const mockedBootstrap = vi.mocked(bootstrap);
const mockedRunPlanner = vi.mocked(runPlanner);

const fakeRuntime = (
  shutdown = vi.fn().mockResolvedValue(undefined),
): SaivageRuntime =>
  ({
    project: { projectRoot: "/tmp/x", saivageDir: "/tmp/x/.saivage" },
    shutdown,
  }) as unknown as SaivageRuntime;

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.exitCode = undefined;
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`__exit:${code ?? 0}`);
  }) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mockedBootstrap.mockReset();
  mockedRunPlanner.mockReset();
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("withRuntime", () => {
  it("calls shutdown exactly once and exits 0 on the happy path", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    mockedBootstrap.mockResolvedValue(fakeRuntime(shutdown));

    await expect(withRuntime(undefined, async () => {})).rejects.toThrow("__exit:0");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs Error:, calls shutdown once, and exits 1 on callback throw", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    mockedBootstrap.mockResolvedValue(fakeRuntime(shutdown));

    await expect(
      withRuntime(undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("__exit:1");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
  });

  it("does not call shutdown and exits 1 when bootstrap rejects", async () => {
    const callback = vi.fn();
    mockedBootstrap.mockRejectedValue(new Error("bootstrap failed"));

    await expect(withRuntime(undefined, callback)).rejects.toThrow("__exit:1");

    expect(callback).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: bootstrap failed"));
  });

  it("preserves process.exitCode set by the callback", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    mockedBootstrap.mockResolvedValue(fakeRuntime(shutdown));

    await expect(
      withRuntime(undefined, async () => {
        process.exitCode = 1;
      }),
    ).rejects.toThrow("__exit:1");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("logs both errors when shutdown rejects after a callback throw", async () => {
    const shutdown = vi.fn().mockRejectedValue(new Error("shutdown failed"));
    mockedBootstrap.mockResolvedValue(fakeRuntime(shutdown));

    await expect(
      withRuntime(undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("__exit:1");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Shutdown error: shutdown failed"));
  });

  it("calls shutdown exactly once when callback throws and sets exitCode", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    mockedBootstrap.mockResolvedValue(fakeRuntime(shutdown));

    await expect(
      withRuntime(undefined, async () => {
        process.exitCode = 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("__exit:1");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("logs Shutdown error: but exits 0 when only shutdown rejects on a successful run", async () => {
    const shutdown = vi.fn().mockRejectedValue(new Error("teardown failed"));
    mockedBootstrap.mockResolvedValue(fakeRuntime(shutdown));

    await expect(withRuntime(undefined, async () => {})).rejects.toThrow("__exit:0");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Shutdown error: teardown failed"));
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("Error: teardown failed"));
  });
});
