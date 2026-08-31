import type { AcpApplicationPort } from "../ports/acp-application.js";
import type { AcceptedAcpRun } from "../ports/acp-application.js";
import { DomainError } from "../domain/errors.js";
import type { RunExecutionPort } from "./run-executor.js";

type RunSlot = {
  controller: AbortController;
  current: Promise<unknown>;
  accepted?: AcceptedAcpRun;
  execution?: Promise<unknown>;
};

export interface RunLifecyclePort extends RunExecutionPort {
  admit(
    sessionId: string,
    operation: (signal: AbortSignal) => Promise<AcceptedAcpRun>,
  ): Promise<AcceptedAcpRun>;
  cancel(sessionId: string): Promise<void>;
}

export class RunSupervisor implements RunLifecyclePort {
  private readonly stopping = new AbortController();
  private readonly active = new Map<string, RunSlot>();

  public constructor(private readonly delegate: RunExecutionPort) {}

  public admit(
    sessionId: string,
    operation: (signal: AbortSignal) => Promise<AcceptedAcpRun>,
  ): Promise<AcceptedAcpRun> {
    if (this.stopping.signal.aborted) {
      return Promise.reject(
        new DomainError("service_stopping", "Agent ACP Service is not accepting new Runs"),
      );
    }
    if (this.active.has(sessionId)) {
      return Promise.reject(
        new DomainError("session_busy", "Session already has a non-terminal Run"),
      );
    }
    const controller = new AbortController();
    const slot: RunSlot = { controller, current: Promise.resolve() };
    const admission = Promise.resolve()
      .then(() => operation(AbortSignal.any([controller.signal, this.stopping.signal])))
      .then((accepted) => {
        slot.accepted = accepted;
        return accepted;
      });
    slot.current = admission;
    this.active.set(sessionId, slot);
    void admission.catch(() => this.remove(sessionId, slot));
    return admission;
  }

  public execute(
    input: Parameters<AcpApplicationPort["executeRun"]>[0],
  ): ReturnType<AcpApplicationPort["executeRun"]> {
    if (this.stopping.signal.aborted) {
      return Promise.reject(
        new DomainError("service_stopping", "Agent ACP Service is not accepting new Runs"),
      );
    }
    const sessionId = input.accepted.sessionId;
    const slot = this.active.get(sessionId) ?? {
      controller: new AbortController(),
      current: Promise.resolve(),
    };
    if (slot.execution !== undefined) {
      return Promise.reject(new DomainError("session_busy", "Session Run is already executing"));
    }
    if (slot.accepted !== undefined && slot.accepted.runId !== input.accepted.runId) {
      return Promise.reject(new DomainError("session_busy", "Session Run admission changed"));
    }
    slot.accepted = input.accepted;
    this.active.set(sessionId, slot);
    const execution = Promise.resolve().then(() =>
      this.delegate.execute({
        ...input,
        signal: AbortSignal.any([input.signal, slot.controller.signal, this.stopping.signal]),
      }),
    );
    slot.execution = execution;
    slot.current = execution;
    void execution.finally(() => this.remove(sessionId, slot)).catch(() => undefined);
    return execution;
  }

  public async cancel(sessionId: string): Promise<void> {
    const slot = this.active.get(sessionId);
    if (slot === undefined) {
      return;
    }
    slot.controller.abort(new Error("ACP Session cancelled"));
    await Promise.allSettled([slot.current]);
  }

  public stop(reason: Error): void {
    if (!this.stopping.signal.aborted) {
      this.stopping.abort(reason);
    }
    for (const slot of this.active.values()) {
      slot.controller.abort(reason);
    }
  }

  public async shutdown(): Promise<void> {
    this.stop(new Error("Agent ACP Service is shutting down"));
    await Promise.allSettled([...this.active.values()].map((slot) => slot.current));
  }

  private remove(sessionId: string, slot: RunSlot): void {
    if (this.active.get(sessionId) === slot) {
      this.active.delete(sessionId);
    }
  }
}
