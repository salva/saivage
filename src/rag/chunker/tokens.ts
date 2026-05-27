// F01 B05 — tokenizer for chunkers.
//
// Uses `js-tiktoken`'s `cl100k_base` encoder. Falls back to
// `Math.ceil(len / 4)` when the encoder fails to load.

import { getEncoding, type Tiktoken } from "js-tiktoken";

const FALLBACK_FACTOR = 4;

let encoder: Tiktoken | null = null;
let loadTried = false;

function ensureEncoder(): Tiktoken | null {
  if (loadTried) return encoder;
  loadTried = true;
  try {
    encoder = getEncoding("cl100k_base");
  } catch {
    encoder = null;
  }
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  const enc = ensureEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      // fall through to the rough estimator
    }
  }
  return Math.ceil(text.length / FALLBACK_FACTOR);
}

// Test-only: reset the cached encoder.
export function __resetTokenCache(): void {
  encoder = null;
  loadTried = false;
}
