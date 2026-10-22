export type RuntimeBarrierScope = {
  organizationId: string;
  agentId: string;
  expectedRuntimeRevision: string;
};

export type RuntimeBarrier = {
  barrierId: string;
  runtimeExecutionId: string;
};

export type RuntimeBarrierState = {
  runtimeRevision: string;
  barrier: RuntimeBarrier | null;
};

export interface RuntimeBarrierReader {
  // Call only after the configuration source is initialized and available.
  // An absent organization or Agent is not_found; failed reads remain errors.
  readCurrentBarrier(
    scope: RuntimeBarrierScope,
    signal?: AbortSignal,
  ): Promise<RuntimeBarrierState>;
}
