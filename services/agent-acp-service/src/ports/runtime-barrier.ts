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
  readCurrentBarrier(
    scope: RuntimeBarrierScope,
    signal?: AbortSignal,
  ): Promise<RuntimeBarrierState>;
}
