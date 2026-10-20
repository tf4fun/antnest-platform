export function assertDurable(saved: unknown, receipt: unknown): void;
export function assertRecovered(
  before: unknown,
  after: unknown,
  phase: string,
): void;
export function assertReplay(
  version: number,
  updates: unknown[],
  saved: unknown,
  sessionId: unknown,
): void;
