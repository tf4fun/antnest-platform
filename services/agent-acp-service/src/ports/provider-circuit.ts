export type ProviderCircuitOutcome = "success" | "failure" | "neutral";

export interface ProviderCircuitPermit {
  // Settle once, after the original operation and durable accounting have joined.
  // The return value reports whether another admission is currently blocked.
  settle(outcome: ProviderCircuitOutcome): boolean;
}

export interface ProviderCircuitPort {
  // Only a circuit denial returns undefined. Revoked or changed routing is an error.
  tryModelAttempt(
    organizationId: string,
    connectionId: string,
    baseUrl: string,
  ): ProviderCircuitPermit | undefined;
}
