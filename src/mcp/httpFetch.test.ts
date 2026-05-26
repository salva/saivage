import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { Buffer } from "node:buffer";

import {
  fetchWithTimeout,
  readBoundedTextBody,
  readBoundedBinaryBody,
  discardBody,
  classifyNetworkError,
} from "./httpFetch.js";

interface ServerHandle {
  url: (path?: string) => URL;
  server: Server;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<ServerHandle> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const port = addr.port;
  return {
    server,
    url: (path = "/") => new URL(`http://127.0.0.1:${port}${path}`),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("httpFetch.fetchWithTimeout", () => {
  it("returns a TimedFetch whose dispose clears the timer", async () => {
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 30_000);
      try {
        expect(timed.response.status).toBe(200);
        expect(timed.timedOut()).toBe(false);
        await timed.response.text();
      } finally {
        timed.dispose();
        timed.dispose(); // idempotent
      }
    } finally {
      await h.close();
    }
  });

  it("throws and disposes on pre-headers connection refused", async () => {
    await expect(
      fetchWithTimeout(new URL("http://127.0.0.1:1/"), {}, 5_000),
    ).rejects.toBeInstanceOf(Error);
  });

  it("times out when the upstream never sends headers", async () => {
    const h = await startServer((_req, _res) => {
      // hang indefinitely
    });
    try {
      const start = Date.now();
      let caught: unknown = null;
      try {
        const timed = await fetchWithTimeout(h.url(), {}, 100);
        timed.dispose();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(Date.now() - start).toBeLessThan(2_000);
    } finally {
      await h.close();
    }
  });
});

describe("httpFetch.readBoundedTextBody", () => {
  it("returns the full body when below the cap", async () => {
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("hello world");
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 10_000);
      try {
        const read = await readBoundedTextBody(timed.response, 1_000, timed.signal);
        expect(read.body).toBe("hello world");
        expect(read.bytes).toBe(11);
        expect(read.truncated).toBe(false);
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });

  it("truncates and cancels the socket above the cap", async () => {
    let aborted = false;
    const h = await startServer((req, res) => {
      req.on("aborted", () => { aborted = true; });
      req.on("close", () => { if (!res.writableEnded) aborted = true; });
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      const chunk = Buffer.alloc(64 * 1024, 65); // 'A'
      let written = 0;
      const writeMore = (): void => {
        if (written >= 5 * 1024 * 1024) { res.end(); return; }
        if (!res.write(chunk)) { res.once("drain", writeMore); return; }
        written += chunk.length;
        setImmediate(writeMore);
      };
      writeMore();
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 10_000);
      try {
        const read = await readBoundedTextBody(timed.response, 50_000, timed.signal);
        expect(read.truncated).toBe(true);
        expect(read.bytes).toBe(50_000);
        expect(read.body.length).toBe(50_000);
      } finally {
        timed.dispose();
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(aborted).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("returns empty for response with null body", async () => {
    const h = await startServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 5_000);
      try {
        const read = await readBoundedTextBody(timed.response, 1_000, timed.signal);
        expect(read.bytes).toBe(0);
        expect(read.truncated).toBe(false);
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });

  it("drops a partial multi-byte UTF-8 rune at the cap (no U+FFFD)", async () => {
    const payload = Buffer.from("日".repeat(334), "utf-8"); // 1002 bytes
    expect(payload.length).toBe(1002);
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(payload);
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 10_000);
      try {
        const read = await readBoundedTextBody(timed.response, 1_000, timed.signal);
        expect(read.truncated).toBe(true);
        expect(read.bytes).toBeLessThanOrEqual(1_000);
        expect(read.body.includes("\uFFFD")).toBe(false);
        expect(read.body.length).toBe(333);
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });

  it("keeps untruncated multi-byte input intact (no U+FFFD)", async () => {
    const payload = Buffer.from("日".repeat(334), "utf-8");
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(payload);
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 10_000);
      try {
        const read = await readBoundedTextBody(timed.response, 2_000, timed.signal);
        expect(read.truncated).toBe(false);
        expect(read.body.includes("\uFFFD")).toBe(false);
        expect(read.body.length).toBe(334);
        expect(read.bytes).toBe(1002);
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });

  it("throws (does not partially succeed) when the signal aborts mid-body", async () => {
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.write(Buffer.alloc(1024, 65));
      // never end; force timeout
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 200);
      try {
        await expect(
          readBoundedTextBody(timed.response, 10 * 1024 * 1024, timed.signal),
        ).rejects.toBeInstanceOf(Error);
        const cls = classifyNetworkError(
          new Error("aborted"),
          h.url().toString(),
          { timedOut: timed.timedOut() },
        );
        expect(cls.code).toBe("TIMEOUT");
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });
});

describe("httpFetch.readBoundedBinaryBody", () => {
  it("returns full body when below cap", async () => {
    const payload = Buffer.alloc(1024, 7);
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end(payload);
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 10_000);
      try {
        const read = await readBoundedBinaryBody(timed.response, 10_000, timed.signal);
        expect(read.bytes).toBe(1024);
        expect(read.truncated).toBe(false);
        expect(read.body.equals(payload)).toBe(true);
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });

  it("truncates above cap", async () => {
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end(Buffer.alloc(10_000, 1));
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 10_000);
      try {
        const read = await readBoundedBinaryBody(timed.response, 1_000, timed.signal);
        expect(read.truncated).toBe(true);
        expect(read.bytes).toBe(1_000);
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });
});

describe("httpFetch.discardBody", () => {
  it("is safe on a body that is already drained", async () => {
    const h = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end("x");
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 5_000);
      try {
        await timed.response.text();
        await discardBody(timed.response);
      } finally {
        timed.dispose();
      }
    } finally {
      await h.close();
    }
  });

  it("cancels an in-flight body", async () => {
    let aborted = false;
    const h = await startServer((req, res) => {
      req.on("close", () => { if (!res.writableEnded) aborted = true; });
      res.statusCode = 500;
      const chunk = Buffer.alloc(64 * 1024, 0);
      const writeMore = (): void => {
        if (!res.write(chunk)) { res.once("drain", writeMore); return; }
        setImmediate(writeMore);
      };
      writeMore();
    });
    try {
      const timed = await fetchWithTimeout(h.url(), {}, 10_000);
      try {
        await discardBody(timed.response);
      } finally {
        timed.dispose();
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(aborted).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("httpFetch.classifyNetworkError", () => {
  it("maps TimeoutError name to TIMEOUT", () => {
    const err = new Error("x");
    err.name = "TimeoutError";
    const cls = classifyNetworkError(err, "https://example/");
    expect(cls.code).toBe("TIMEOUT");
  });

  it("forces TIMEOUT when ctx.timedOut overrides", () => {
    const cls = classifyNetworkError(new Error("any"), "https://x/", { timedOut: true });
    expect(cls.code).toBe("TIMEOUT");
  });

  it("maps errno on the top-level error to NETWORK_ERROR + errno", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const cls = classifyNetworkError(err, "http://127.0.0.1:1/");
    expect(cls.code).toBe("NETWORK_ERROR");
    expect(cls.errno).toBe("ECONNREFUSED");
  });

  it("walks .cause for errno on undici-shaped errors", () => {
    const cause = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const cls = classifyNetworkError(err, "http://x/");
    expect(cls.code).toBe("NETWORK_ERROR");
    expect(cls.errno).toBe("ECONNRESET");
  });

  it("falls back to NETWORK_ERROR with no errno for unclassified errors", () => {
    const cls = classifyNetworkError(new Error("weird"), "http://x/");
    expect(cls.code).toBe("NETWORK_ERROR");
    expect(cls.errno).toBeUndefined();
  });
});
