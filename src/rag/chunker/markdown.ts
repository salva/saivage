// F01 B05 — Markdown chunker.
//
// Header-recursive splitter: walks the source, segments by ATX-style headings
// (`#` .. `######`), records the heading path on every emitted chunk,
// greedy-merges undersized siblings under the same heading, splits oversize
// sections at paragraph boundaries, and falls back to hard token-count splits
// on whitespace when no finer boundary exists.
//
// Cap policy: every emitted chunk is <= `chunkSize` tokens (default
// DEFAULT_CHUNK_TOKEN_CAP). Overlap is a fraction in [0, 0.5], default
// DEFAULT_MARKDOWN_OVERLAP_RATIO.

import type { ChunkerInput, ChunkMetadata, RawChunk } from "../types.js";
import {
  type Chunker,
  DEFAULT_CHUNK_TOKEN_CAP,
  DEFAULT_MARKDOWN_OVERLAP_RATIO,
} from "./index.js";
import { countTokens } from "./tokens.js";

interface Section {
  headingPath: string[];      // ordered list of headings (current path)
  startLine: number;          // 1-based
  endLine: number;
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let path: string[] = [];
  let buf: string[] = [];
  let bufStart = 1;

  const flush = (endLine: number): void => {
    const body = buf.join("\n").trim();
    if (body.length === 0) { buf = []; return; }
    sections.push({ headingPath: [...path], startLine: bufStart, endLine, text: body });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = HEADING_RE.exec(line);
    if (m) {
      flush(i); // previous section ends on the line before this heading
      const level = (m[1] ?? "").length;
      const title = m[2] ?? "";
      path = path.slice(0, level - 1);
      path[level - 1] = title;
      bufStart = i + 1;
      buf.push(line);
    } else {
      if (buf.length === 0) bufStart = i + 1;
      buf.push(line);
    }
  }
  flush(lines.length);
  return sections;
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
}

function hardSplit(text: string, capTokens: number): string[] {
  // Split on whitespace runs, greedy-pack words up to capTokens.
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  let cur: string[] = [];
  let curTok = 0;
  for (const w of words) {
    const t = Math.max(1, countTokens(w));
    if (curTok + t > capTokens && cur.length > 0) {
      out.push(cur.join(" "));
      cur = [];
      curTok = 0;
    }
    cur.push(w);
    curTok += t;
  }
  if (cur.length > 0) out.push(cur.join(" "));
  return out;
}

function joinWithOverlap(pieces: string[], overlapRatio: number, capTokens: number): string[] {
  if (overlapRatio <= 0 || pieces.length <= 1) return pieces;
  const out: string[] = [];
  const overlapTokens = Math.floor(capTokens * overlapRatio);
  let prevTailWords: string[] = [];
  for (const p of pieces) {
    let head = "";
    if (prevTailWords.length > 0) head = prevTailWords.join(" ") + "\n";
    out.push((head + p).trim());
    const words = p.split(/\s+/).filter((w) => w.length > 0);
    // Take trailing words ~ overlapTokens.
    let acc = 0;
    const tail: string[] = [];
    for (let i = words.length - 1; i >= 0; i--) {
      const t = Math.max(1, countTokens(words[i] ?? ""));
      if (acc + t > overlapTokens) break;
      tail.unshift(words[i] ?? "");
      acc += t;
    }
    prevTailWords = tail;
  }
  return out;
}

function splitOversize(text: string, capTokens: number, overlapRatio: number): string[] {
  if (countTokens(text) <= capTokens) return [text];
  // Try paragraph-level greedy packing.
  const paras = splitParagraphs(text);
  if (paras.length > 1) {
    const packed: string[] = [];
    let cur: string[] = [];
    let curTok = 0;
    for (const p of paras) {
      const t = countTokens(p);
      if (t > capTokens) {
        if (cur.length > 0) { packed.push(cur.join("\n\n")); cur = []; curTok = 0; }
        // Single paragraph too large — hard split.
        for (const piece of hardSplit(p, capTokens)) packed.push(piece);
        continue;
      }
      if (curTok + t > capTokens && cur.length > 0) {
        packed.push(cur.join("\n\n"));
        cur = []; curTok = 0;
      }
      cur.push(p);
      curTok += t;
    }
    if (cur.length > 0) packed.push(cur.join("\n\n"));
    return joinWithOverlap(packed, overlapRatio, capTokens);
  }
  // No paragraph boundary — hard split.
  return joinWithOverlap(hardSplit(text, capTokens), overlapRatio, capTokens);
}

function buildMetadata(input: ChunkerInput, headingPath: string[], chunkIndex: number, startLine?: number, endLine?: number): ChunkMetadata {
  const overlay = input.metadataOverlay ?? {};
  return {
    path: input.path,
    source: input.source,
    chunkIndex,
    startLine: startLine ?? overlay.startLine,
    endLine: endLine ?? overlay.endLine,
    contentHash: "",
    sourceHash: input.sourceHash,
    mtimeMs: input.mtimeMs,
    language: input.language ?? overlay.language,
    headingPath: headingPath.length > 0 ? headingPath.join(" > ") : overlay.headingPath,
    symbolName: overlay.symbolName,
    symbolKind: overlay.symbolKind,
    scope: overlay.scope,
    scopeRef: overlay.scopeRef,
    role: overlay.role,
    lifecycleStatus: overlay.lifecycleStatus,
    createdAt: overlay.createdAt,
    supersedes: overlay.supersedes,
  };
}

export class MarkdownChunker implements Chunker {
  async *chunk(input: ChunkerInput): AsyncIterable<RawChunk> {
    const capTokens = input.chunkSize ?? DEFAULT_CHUNK_TOKEN_CAP;
    const overlap = input.overlap ?? DEFAULT_MARKDOWN_OVERLAP_RATIO;
    if (capTokens <= 0) return;
    const sections = splitSections(input.text);
    if (sections.length === 0) return;

    // Greedy-merge consecutive sections sharing the same heading path until
    // they exceed half the cap, to coalesce undersized siblings.
    const merged: Section[] = [];
    for (const s of sections) {
      const last = merged.length > 0 ? merged[merged.length - 1] : undefined;
      if (
        last &&
        last.headingPath.join("\n") === s.headingPath.join("\n") &&
        countTokens(last.text) + countTokens(s.text) <= Math.max(1, Math.floor(capTokens / 2))
      ) {
        last.text = `${last.text}\n\n${s.text}`;
        last.endLine = s.endLine;
        continue;
      }
      merged.push({ ...s });
    }

    let chunkIndex = 0;
    for (const sec of merged) {
      const pieces = splitOversize(sec.text, capTokens, overlap);
      for (const piece of pieces) {
        if (piece.trim().length === 0) continue;
        yield {
          text: piece,
          metadata: buildMetadata(input, sec.headingPath, chunkIndex++, sec.startLine, sec.endLine),
        };
      }
    }
  }
}
