/**
 * Content provenance — tracks hashes of self-generated content
 * so the scanner can exempt them from injection checks.
 */
import { createHash } from "node:crypto";

export class ProvenanceRegistry {
  private hashes = new Set<string>();

  /** Register content as self-generated */
  register(content: string): string {
    const hash = this.hash(content);
    this.hashes.add(hash);
    return hash;
  }

  /** Check if content was self-generated */
  isSelfGenerated(content: string): boolean {
    return this.hashes.has(this.hash(content));
  }

  /** Clear the registry */
  clear(): void {
    this.hashes.clear();
  }

  /** Number of tracked items */
  get size(): number {
    return this.hashes.size;
  }

  private hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
