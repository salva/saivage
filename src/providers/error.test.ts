/**
 * Saivage \u2014 F13 provider-error classification tests.
 */

import { describe, it, expect } from "vitest";
import { ProviderError, classifyProviderError, parseRetryAfter } from "./error.js";

function fakeAnthropicError(opts: {
  status?: number;
  type?: string;
  message?: string;
  headers?: Record<string, string>;
}): Error {
  const e = new Error(opts.message ?? "anthropic err");
  Object.assign(e, {
    status: opts.status,
    error: { error: { type: opts.type, message: opts.message } },
    headers: opts.headers,
  });
  return e;
}

function fakeOpenAIError(opts: {
  status?: number;
  code?: string;
  type?: string;
  message?: string;
  headers?: Record<string, string>;
}): Error {
  const e = new Error(opts.message ?? "openai err");
  Object.assign(e, {
    status: opts.status,
    code: opts.code,
    type: opts.type,
    headers: opts.headers,
  });
  return e;
}

describe("parseRetryAfter", () => {
  it("parses integer seconds to milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });
  it("parses fractional seconds", () => {
    expect(parseRetryAfter("1.5")).toBe(1_500);
  });
  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).toBeGreaterThan(3000);
    expect(parsed).toBeLessThanOrEqual(5000);
  });
  it("returns undefined on garbage", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
  });
});

describe("classifyProviderError \u2014 Anthropic shapes", () => {
  it("overloaded_error \u2192 throttling", () => {
    const e = fakeAnthropicError({ status: 529, type: "overloaded_error" });
    const cls = classifyProviderError(e, "anthropic");
    expect(cls.kind).toBe("throttling");
  });
  it("rate_limit_error \u2192 throttling with retryAfterMs", () => {
    const e = fakeAnthropicError({ status: 429, type: "rate_limit_error", headers: { "retry-after": "10" } });
    const cls = classifyProviderError(e, "anthropic");
    expect(cls.kind).toBe("throttling");
    expect(cls.retryAfterMs).toBe(10_000);
  });
  it("invalid_request_error \u2192 non_retryable", () => {
    const e = fakeAnthropicError({ status: 400, type: "invalid_request_error" });
    const cls = classifyProviderError(e, "anthropic");
    expect(cls.kind).toBe("non_retryable");
  });
  it("authentication_error \u2192 non_retryable", () => {
    const e = fakeAnthropicError({ status: 401, type: "authentication_error" });
    expect(classifyProviderError(e, "anthropic").kind).toBe("non_retryable");
  });
  it("context length message \u2192 context_overflow regardless of type", () => {
    const e = fakeAnthropicError({ status: 400, message: "prompt is too long" });
    expect(classifyProviderError(e, "anthropic").kind).toBe("context_overflow");
  });
});

describe("classifyProviderError \u2014 OpenAI shapes", () => {
  it("context_length_exceeded code \u2192 context_overflow", () => {
    const e = fakeOpenAIError({ status: 400, code: "context_length_exceeded" });
    expect(classifyProviderError(e, "openai").kind).toBe("context_overflow");
  });
  it("429 \u2192 throttling with retry-after-ms header", () => {
    const e = fakeOpenAIError({ status: 429, headers: { "retry-after-ms": "2500" } });
    const cls = classifyProviderError(e, "openai");
    expect(cls.kind).toBe("throttling");
    expect(cls.retryAfterMs).toBe(2500);
  });
  it("5xx \u2192 transient", () => {
    const e = fakeOpenAIError({ status: 503 });
    expect(classifyProviderError(e, "openai").kind).toBe("transient");
  });
  it("401 \u2192 non_retryable", () => {
    const e = fakeOpenAIError({ status: 401 });
    expect(classifyProviderError(e, "openai").kind).toBe("non_retryable");
  });
});

describe("classifyProviderError \u2014 raw Error / Codex API", () => {
  it("Codex API 429 \u2192 throttling", () => {
    const cls = classifyProviderError(new Error("Codex API 429: rate limit"), "openai-codex");
    expect(cls.kind).toBe("throttling");
    expect(cls.status).toBe(429);
  });
  it("Codex API 400 \u2192 non_retryable", () => {
    const cls = classifyProviderError(new Error("Codex API 400: bad request"), "openai-codex");
    expect(cls.kind).toBe("non_retryable");
  });
  it("Codex API 500 \u2192 transient", () => {
    const cls = classifyProviderError(new Error("Codex API 500: oh no"), "openai-codex");
    expect(cls.kind).toBe("transient");
  });
  it("unknown raw Error \u2192 transient", () => {
    const cls = classifyProviderError(new Error("something exploded"), "x");
    expect(cls.kind).toBe("transient");
  });
});

describe("classifyProviderError \u2014 idempotence", () => {
  it("returns the same ProviderError instance when given one", () => {
    const pe = new ProviderError({ kind: "throttling", message: "x" });
    expect(classifyProviderError(pe, "any")).toBe(pe);
  });
});
