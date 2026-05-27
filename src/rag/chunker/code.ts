// F01 B05 — Code chunker.
//
// Uses tree-sitter for TypeScript (.ts/.tsx) and Python (.py). Emits one
// chunk per top-level named construct (function/class/interface/...) plus a
// `module` chunk for any prelude text between symbols.  On grammar load
// failure, or for unsupported languages, falls back to a regex/blank-line
// splitter that does NOT populate symbol metadata.

import { createRequire } from "node:module";

import type { ChunkerInput, ChunkMetadata, RawChunk } from "../types.js";
import { type Chunker, DEFAULT_CHUNK_TOKEN_CAP } from "./index.js";
import { countTokens } from "./tokens.js";

const requireCjs = createRequire(import.meta.url);

interface TreeSitterNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number };
  readonly endPosition: { row: number };
  readonly namedChildCount: number;
  readonly children: TreeSitterNode[];
  readonly namedChildren: TreeSitterNode[];
  readonly isNamed: boolean;
  childForFieldName(name: string): TreeSitterNode | null;
  descendantsOfType(type: string | string[]): TreeSitterNode[];
}
interface TreeSitterTree { readonly rootNode: TreeSitterNode; }
interface TreeSitterParser { setLanguage(lang: unknown): void; parse(text: string): TreeSitterTree; }

interface ParserBundle {
  parser: TreeSitterParser;
  language: "typescript" | "python";
}

function loadParser(lang: string): ParserBundle | null {
  try {
    const Parser = requireCjs("tree-sitter") as new () => TreeSitterParser;
    const parser = new Parser();
    if (lang === "typescript" || lang === "ts") {
      const grammar = requireCjs("tree-sitter-typescript") as { typescript: unknown };
      parser.setLanguage(grammar.typescript);
      return { parser, language: "typescript" };
    }
    if (lang === "tsx") {
      const grammar = requireCjs("tree-sitter-typescript") as { tsx: unknown };
      parser.setLanguage(grammar.tsx);
      return { parser, language: "typescript" };
    }
    if (lang === "python" || lang === "py") {
      const grammar = requireCjs("tree-sitter-python") as unknown;
      parser.setLanguage(grammar);
      return { parser, language: "python" };
    }
    return null;
  } catch {
    return null;
  }
}

const SYMBOL_TYPES: Record<"typescript" | "python", Set<string>> = {
  typescript: new Set([
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "method_definition",
    "lexical_declaration",
    "export_statement",
  ]),
  python: new Set([
    "function_definition",
    "class_definition",
    "decorated_definition",
  ]),
};

function kindLabel(type: string): string {
  if (type.includes("class")) return "class";
  if (type.includes("interface")) return "interface";
  if (type.includes("enum")) return "enum";
  if (type.includes("type_alias")) return "type";
  if (type.includes("method")) return "method";
  if (type.includes("function") || type === "lexical_declaration") return "function";
  return type;
}

function extractName(node: TreeSitterNode): string | undefined {
  const named = node.childForFieldName("name");
  if (named) return sliceText(named);
  // Walk: take first identifier descendant.
  const ids = node.descendantsOfType(["identifier", "type_identifier"]);
  const first = ids[0];
  return first ? sliceText(first) : undefined;
}

let parseCache: { text: string; tree: TreeSitterTree } | null = null;
function sliceText(node: TreeSitterNode): string {
  return parseCache ? parseCache.text.slice(node.startIndex, node.endIndex) : "";
}

function buildMetadata(
  input: ChunkerInput,
  chunkIndex: number,
  startLine: number | undefined,
  endLine: number | undefined,
  language: string | undefined,
  symbol: { name?: string; kind?: string } = {},
): ChunkMetadata {
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
    language: language ?? input.language ?? overlay.language,
    headingPath: overlay.headingPath,
    symbolName: symbol.name ?? overlay.symbolName,
    symbolKind: symbol.kind ?? overlay.symbolKind,
    scope: overlay.scope,
    scopeRef: overlay.scopeRef,
    role: overlay.role,
    lifecycleStatus: overlay.lifecycleStatus,
    createdAt: overlay.createdAt,
    supersedes: overlay.supersedes,
  };
}

function hardSplitByLines(text: string, capTokens: number): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let curTok = 0;
  for (const ln of lines) {
    const t = Math.max(1, countTokens(ln));
    if (curTok + t > capTokens && cur.length > 0) {
      out.push(cur.join("\n"));
      cur = [];
      curTok = 0;
    }
    cur.push(ln);
    curTok += t;
  }
  if (cur.length > 0) out.push(cur.join("\n"));
  return out;
}

function blankLineSplit(text: string, capTokens: number): string[] {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
  const out: string[] = [];
  let cur: string[] = [];
  let curTok = 0;
  for (const b of blocks) {
    const t = countTokens(b);
    if (t > capTokens) {
      if (cur.length > 0) { out.push(cur.join("\n\n")); cur = []; curTok = 0; }
      for (const piece of hardSplitByLines(b, capTokens)) out.push(piece);
      continue;
    }
    if (curTok + t > capTokens && cur.length > 0) {
      out.push(cur.join("\n\n"));
      cur = [];
      curTok = 0;
    }
    cur.push(b);
    curTok += t;
  }
  if (cur.length > 0) out.push(cur.join("\n\n"));
  return out;
}

function detectLanguage(input: ChunkerInput): string | undefined {
  if (input.language) return input.language;
  const p = input.path.toLowerCase();
  if (p.endsWith(".tsx")) return "tsx";
  if (p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".py")) return "python";
  return undefined;
}

export class CodeChunker implements Chunker {
  async *chunk(input: ChunkerInput): AsyncIterable<RawChunk> {
    const capTokens = input.chunkSize ?? DEFAULT_CHUNK_TOKEN_CAP;
    if (capTokens <= 0) return;
    const language = detectLanguage(input);
    const bundle = language ? loadParser(language) : null;

    if (!bundle) {
      // Fallback: regex/blank-line splitter, no symbol metadata.
      const pieces = blankLineSplit(input.text, capTokens);
      let i = 0;
      for (const p of pieces) {
        if (p.trim().length === 0) continue;
        yield { text: p, metadata: buildMetadata(input, i++, undefined, undefined, language) };
      }
      return;
    }

    parseCache = { text: input.text, tree: bundle.parser.parse(input.text) };
    const bundleLanguage = bundle.language;
    try {
      const root = parseCache.tree.rootNode;
      const symbolTypes = SYMBOL_TYPES[bundleLanguage];
      const topLevel: TreeSitterNode[] = root.namedChildren.filter((c) => symbolTypes.has(c.type));
      // Sort by start.
      topLevel.sort((a, b) => a.startIndex - b.startIndex);

      let chunkIndex = 0;
      let cursor = 0;
      const fullText = parseCache.text;

      function* emitPrelude(until: number): Generator<RawChunk> {
        const slice = fullText.slice(cursor, until).trim();
        const prevCursor = cursor;
        cursor = until;
        if (slice.length === 0) return;
        const pieces = blankLineSplit(slice, capTokens);
        const startRow = countLinesUpTo(fullText, prevCursor) + 1;
        for (let pi = 0; pi < pieces.length; pi++) {
          const piece = pieces[pi];
          if (piece === undefined) continue;
          yield {
            text: piece,
            metadata: buildMetadata(
              input,
              chunkIndex++,
              startRow,
              startRow + pi,
              bundleLanguage,
              { kind: "module" },
            ),
          };
        }
      }

      for (const node of topLevel) {
        // emit any prelude text between previous symbol and this one
        for (const ch of emitPrelude(node.startIndex)) yield ch;
        cursor = node.endIndex;

        const text = fullText.slice(node.startIndex, node.endIndex);
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const name = extractName(node);
        const kind = kindLabel(node.type);
        const tok = countTokens(text);
        if (tok <= capTokens) {
          yield {
            text,
            metadata: buildMetadata(input, chunkIndex++, startLine, endLine, bundleLanguage, { name, kind }),
          };
        } else {
          // Oversize symbol — split at statement-ish boundaries.
          const pieces = blankLineSplit(text, capTokens);
          for (const piece of pieces) {
            yield {
              text: piece,
              metadata: buildMetadata(
                input,
                chunkIndex++,
                startLine,
                endLine,
                bundleLanguage,
                { name, kind: `${kind}_fragment` },
              ),
            };
          }
        }
      }
      // Trailing prelude.
      for (const ch of emitPrelude(fullText.length)) yield ch;
    } finally {
      parseCache = null;
    }
  }
}

function countLinesUpTo(text: string, idx: number): number {
  if (idx < 0) return 0;
  let n = 0;
  for (let i = 0; i < idx && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}
