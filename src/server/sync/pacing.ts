export type PacerOpts = { ratePerSecond: number; burst: number };

export class Pacer {
  private tokens: number;
  private lastRefill: number;
  constructor(private readonly opts: PacerOpts) {
    this.tokens = opts.burst;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.opts.ratePerSecond) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.opts.burst, this.tokens + elapsed * this.opts.ratePerSecond);
    this.lastRefill = now;
  }
}

export function pacerForRateLimit(callsPer24h: number): Pacer {
  // Smooth across the day with a small burst allowance.
  const ratePerSecond = callsPer24h / (24 * 60 * 60);
  return new Pacer({ ratePerSecond, burst: Math.max(5, Math.floor(callsPer24h / 60)) });
}
