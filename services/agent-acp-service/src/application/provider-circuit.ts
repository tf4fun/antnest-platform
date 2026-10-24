import type { ProviderCircuitOutcome, ProviderCircuitPermit } from "../ports/provider-circuit.js";

export type ProviderCircuitOptions = {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
};

export class ProviderCircuit {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private generation = 0;
  private openedAt = 0;

  public constructor(options: ProviderCircuitOptions = {}) {
    const failureThreshold = options.failureThreshold === undefined ? 3 : options.failureThreshold;
    const cooldownMs = options.cooldownMs === undefined ? 30_000 : options.cooldownMs;
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 100)
      throw new RangeError("Provider circuit failure threshold must be an integer from 1 to 100");
    if (!Number.isInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > 3_600_000)
      throw new RangeError("Provider circuit cooldown must be an integer from 1 to 3600000");
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = options.now ?? (() => performance.now());
  }

  public tryAcquire(): ProviderCircuitPermit | undefined {
    if (this.blocking()) return undefined;
    if (this.state === "open") this.state = "half-open";
    const generation = this.generation;
    const probe = this.state === "half-open";
    let settled = false;
    return {
      settle: (outcome: ProviderCircuitOutcome): boolean => {
        if (!settled) {
          settled = true;
          if (generation === this.generation) {
            if (probe) {
              if (outcome === "success") {
                this.state = "closed";
                this.failures = 0;
                this.generation += 1;
              } else {
                this.open();
              }
            } else if (this.state === "closed") {
              if (outcome === "success") {
                this.failures = 0;
              } else if (outcome === "failure") {
                this.failures += 1;
                if (this.failures >= this.failureThreshold) this.open();
              }
            }
          }
        }
        return this.blocking();
      },
    };
  }

  private open(): void {
    this.state = "open";
    this.generation += 1;
    this.openedAt = this.now();
  }

  private blocking(): boolean {
    return (
      this.state === "half-open" ||
      (this.state === "open" && this.now() - this.openedAt < this.cooldownMs)
    );
  }
}
