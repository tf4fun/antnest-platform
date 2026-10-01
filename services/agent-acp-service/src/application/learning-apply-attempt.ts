import { isDeepStrictEqual } from "node:util";

import {
  admitAutomaticSkillCandidate,
  type ManagedSkillIdentity,
} from "../domain/learning-apply-admission.js";
import type { LearningCandidatePackage } from "../domain/learning-candidate-package.js";
import { learningApplyRequestId } from "../domain/learning-apply-request-id.js";
import type { LearningPolicy } from "../domain/learning-policy.js";
import type { LearningScanScope, LearningTaskClaim } from "../domain/learning-scan.js";
import type { RuntimeInformation } from "../domain/runtime-information.js";

type Binding = { executionId: string; mcpEndpoint: string };
type Candidate = {
  candidateId: string;
  state: string;
  expectedBaseDigest: string | null;
  package: LearningCandidatePackage;
};
type Candidates = { load(claim: LearningTaskClaim): Promise<Candidate | null> };
type Bindings = { current(claim: LearningTaskClaim): Promise<Binding | null> };
type Policies = { read(scope: LearningScanScope): Promise<LearningPolicy> };
type Inventory = {
  readBinding(binding: Binding, signal: AbortSignal): Promise<RuntimeInformation>;
};
type Managed = {
  read(scope: LearningScanScope, packagePath: string): Promise<ManagedSkillIdentity | null>;
};
type Runtime = {
  prepare(input: MaintenanceInput): Promise<{ outcome: "prepared" }>;
  check(input: Omit<MaintenanceInput, "expectedBaseDigest">): Promise<{ outcome: "checked" }>;
  commit(
    input: MaintenanceInput,
  ): Promise<
    | { outcome: "applied"; observed_digest: string }
    | { outcome: "blocked"; observed_digest: null; blocked_reason: string }
  >;
};
type MaintenanceInput = {
  claim: LearningTaskClaim;
  binding: Binding;
  candidateId: string;
  requestId: string;
  package: LearningCandidatePackage;
  expectedBaseDigest: string | null;
  signal: AbortSignal;
};
type ApplyBases = {
  read(
    claim: LearningTaskClaim,
    candidateId: string,
  ): Promise<ReturnType<typeof admitAutomaticSkillCandidate> | null>;
  recordChecked(
    claim: LearningTaskClaim,
    candidateId: string,
    checkRequestId: string,
    basis: ReturnType<typeof admitAutomaticSkillCandidate>,
  ): Promise<{ state: string }>;
};
type CommitRequests = {
  next(
    claim: LearningTaskClaim,
    candidateId: string,
  ): Promise<{
    kind: "fresh" | "pending" | "applied" | "conflict" | "rejected" | "blocked" | "not_ready";
    requestId: string;
    reason?: string;
  }>;
};
type Changes = {
  recordApplied(input: {
    claim: LearningTaskClaim;
    candidateId: string;
    commitRequestId: string;
  }): Promise<{ changeId: string }>;
};

/** Fresh or previously checked candidate; unresolved effects go to observation, never redispatch. */
export class LearningApplyAttempt {
  public constructor(
    private readonly candidates: Candidates,
    private readonly bindings: Bindings,
    private readonly policies: Policies,
    private readonly inventory: Inventory,
    private readonly managed: Managed,
    private readonly runtime: Runtime,
    private readonly bases: ApplyBases,
    private readonly commitRequests: CommitRequests,
    private readonly changes: Changes,
  ) {}

  public async apply(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<
    | { kind: "applied"; changeId: string }
    | { kind: "blocked"; reason: string }
    | { kind: "pending" }
    | { kind: "conflict" | "rejected"; requestId: string }
  > {
    signal.throwIfAborted();
    const candidate = await this.candidates.load(claim);
    if (!candidate || !["draft", "ready_waiting_idle", "applied"].includes(candidate.state))
      throw new Error("Learning apply requires one checked or draft candidate");
    if (candidate.state === "applied") {
      const existing = await this.commitRequests.next(claim, candidate.candidateId);
      if (existing.kind !== "applied") throw new Error("Applied candidate lacks its commit intent");
      const change = await this.changes.recordApplied({
        claim,
        candidateId: candidate.candidateId,
        commitRequestId: existing.requestId,
      });
      return { kind: "applied", changeId: change.changeId };
    }
    const scope = {
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    };
    let frozen: ReturnType<typeof admitAutomaticSkillCandidate>;
    let checkedBinding: Binding | null = null;
    if (candidate.state === "draft") {
      const first = await this.admitCurrent(claim, scope, candidate, signal);
      await this.runtime.prepare({
        claim,
        binding: first.binding,
        candidateId: candidate.candidateId,
        requestId: learningApplyRequestId(claim, candidate.candidateId, "prepare"),
        package: candidate.package,
        expectedBaseDigest: candidate.expectedBaseDigest,
        signal,
      });
      signal.throwIfAborted();
      const checkRequestId = learningApplyRequestId(claim, candidate.candidateId, "check");
      await this.runtime.check({
        claim,
        binding: first.binding,
        candidateId: candidate.candidateId,
        requestId: checkRequestId,
        package: candidate.package,
        signal,
      });
      const checked = await this.admitCurrent(claim, scope, candidate, signal);
      if (!sameBinding(checked.binding, first.binding))
        throw new Error("Runtime execution changed after candidate preparation");
      await this.bases.recordChecked(claim, candidate.candidateId, checkRequestId, checked.basis);
      frozen = checked.basis;
      checkedBinding = checked.binding;
    } else {
      const saved = await this.bases.read(claim, candidate.candidateId);
      if (saved === null) throw new Error("Checked candidate lost its apply basis");
      frozen = saved;
    }
    const current = await this.admitCurrent(claim, scope, candidate, signal);
    if (
      (checkedBinding !== null && !sameBinding(current.binding, checkedBinding)) ||
      !isDeepStrictEqual(current.basis, frozen)
    )
      throw new Error("Skill learning apply authority changed before commit");
    signal.throwIfAborted();
    const request = await this.commitRequests.next(claim, candidate.candidateId);
    if (request.kind === "pending") return { kind: "pending" };
    if (request.kind === "conflict" || request.kind === "rejected")
      return { kind: request.kind, requestId: request.requestId };
    if (request.kind === "blocked")
      return { kind: "blocked", reason: request.reason ?? "writers_unknown" };
    if (request.kind === "not_ready")
      throw new Error("Learning commit task is not ready for a new attempt");
    if (request.kind === "applied") {
      const change = await this.changes.recordApplied({
        claim,
        candidateId: candidate.candidateId,
        commitRequestId: request.requestId,
      });
      return { kind: "applied", changeId: change.changeId };
    }
    const commitRequestId = request.requestId;
    const receipt = await this.runtime.commit({
      claim,
      binding: current.binding,
      candidateId: candidate.candidateId,
      requestId: commitRequestId,
      package: candidate.package,
      expectedBaseDigest: candidate.expectedBaseDigest,
      signal,
    });
    if (receipt.outcome === "blocked") return { kind: "blocked", reason: receipt.blocked_reason };
    if (receipt.observed_digest !== candidate.package.targetDigest)
      throw new Error("Runtime applied a different Skill content digest");
    const change = await this.changes.recordApplied({
      claim,
      candidateId: candidate.candidateId,
      commitRequestId,
    });
    return { kind: "applied", changeId: change.changeId };
  }

  private async admitCurrent(
    claim: LearningTaskClaim,
    scope: LearningScanScope,
    candidate: Candidate,
    signal: AbortSignal,
  ): Promise<{ binding: Binding; basis: ReturnType<typeof admitAutomaticSkillCandidate> }> {
    signal.throwIfAborted();
    const binding = await this.bindings.current(claim);
    if (binding === null) throw new Error("Learning Runtime binding is unavailable");
    const policy = await this.policies.read(scope);
    const managed = await this.managed.read(scope, candidate.package.packagePath);
    const information = await this.inventory.readBinding(binding, signal);
    signal.throwIfAborted();
    const basis = admitAutomaticSkillCandidate({
      claim,
      policy,
      candidate: candidate.package,
      expectedBaseDigest: candidate.expectedBaseDigest,
      managed,
      information,
      executionId: binding.executionId,
    });
    return { binding, basis };
  }
}

function sameBinding(a: Binding, b: Binding): boolean {
  return a.executionId === b.executionId && a.mcpEndpoint === b.mcpEndpoint;
}
