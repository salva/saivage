export interface StickyFailoverState {
  spec: string;
  retryDelayMs: number;
  nextPrimaryRetryAt: number;
}

export class StickyFailoverManager {
  private readonly stickyFailovers = new Map<string, StickyFailoverState>();

  getSticky(spec: string): StickyFailoverState | undefined {
    return this.stickyFailovers.get(spec);
  }

  setSticky(spec: string, state: StickyFailoverState): void {
    this.stickyFailovers.set(spec, state);
  }

  clearStickyFailover(spec: string): StickyFailoverState | undefined {
    const previous = this.stickyFailovers.get(spec);
    this.stickyFailovers.delete(spec);
    return previous;
  }
}
