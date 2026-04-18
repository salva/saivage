/**
 * Prompt injection scanner.
 * Scans external data before it enters the LLM context.
 */
import { INJECTION_PATTERNS, type InjectionPattern } from "./patterns.js";
import { log } from "../log.js";

export interface ScanResult {
  safe: boolean;
  matches: ScanMatch[];
  highestSeverity: "high" | "medium" | "low" | null;
}

export interface ScanMatch {
  pattern: InjectionPattern;
  matchedText: string;
  position: number;
}

export class InjectionScanner {
  private patterns: InjectionPattern[];

  constructor(patterns?: InjectionPattern[]) {
    this.patterns = patterns ?? INJECTION_PATTERNS;
  }

  /** Scan text for potential injection patterns */
  scan(text: string): ScanResult {
    const matches: ScanMatch[] = [];

    for (const pattern of this.patterns) {
      const match = pattern.pattern.exec(text);
      if (match) {
        matches.push({
          pattern,
          matchedText: match[0],
          position: match.index,
        });
      }
    }

    const highestSeverity = matches.reduce<ScanResult["highestSeverity"]>(
      (max, m) => {
        if (m.pattern.severity === "high") return "high";
        if (m.pattern.severity === "medium" && max !== "high") return "medium";
        if (max === null) return m.pattern.severity;
        return max;
      },
      null,
    );

    if (matches.length > 0) {
      log.warn(
        `Injection scanner: ${matches.length} pattern(s) matched (severity: ${highestSeverity})`,
      );
    }

    return {
      safe: matches.length === 0,
      matches,
      highestSeverity,
    };
  }
}
