import {
  admitAutomaticSkillCandidate,
  type AutomaticApplyBasis,
  type ManagedSkillIdentity,
} from "../domain/learning-apply-admission.js";
import type { LearningCandidatePackage } from "../domain/learning-candidate-package.js";
import {
  installRejectionIsResendable,
  RuntimeMaintenanceRejectedError,
  RuntimeMaintenanceUnknownError,
} from "../domain/learning-maintenance-errors.js";
import type { LearningPolicy } from "../domain/learning-policy.js";
import type { LearningScanScope, LearningTaskClaim } from "../domain/learning-scan.js";
import type { RuntimeInformation } from "../domain/runtime-information.js";
import type { RuntimeBinding } from "../domain/types.js";

type Binding = RuntimeBinding;
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
  install(input: {
    claim: LearningTaskClaim;
    binding: Binding;
    candidateId: string;
    requestId: string;
    package: LearningCandidatePackage;
    expectedBaseDigest: string | null;
    signal: AbortSignal;
  }): Promise<
    | { outcome: "applied"; observed_digest: string }
    | { outcome: "conflict"; observed_digest: string | null }
    | { outcome: "blocked"; observed_digest: null; blocked_reason: string }
    | { outcome: "preempted"; observed_digest: null }
  >;
};
type ApplyBases = {
  read(claim: LearningTaskClaim, candidateId: string): Promise<AutomaticApplyBasis | null>;
  recordAdmitted(
    claim: LearningTaskClaim,
    candidateId: string,
    basis: AutomaticApplyBasis,
  ): Promise<{ state: string }>;
};
type InstallRequests = {
  next(
    claim: LearningTaskClaim,
    candidateId: string,
  ): Promise<{
    kind: "fresh" | "applied" | "conflict" | "rejected" | "not_ready";
    requestId: string;
  }>;
};
type Changes = {
  recordApplied(input: {
    claim: LearningTaskClaim;
    candidateId: string;
    installRequestId: string;
  }): Promise<{ changeId: string }>;
};

/**
 * One idle install of a frozen candidate. Install is conditional on the
 * active digest, so any attempt whose outcome is unknown is simply resent.
 */
export class LearningApplyAttempt {
  public constructor(
    private readonly candidates: Candidates,
    private readonly bindings: Bindings,
    private readonly policies: Policies,
    private readonly inventory: Inventory,
    private readonly managed: Managed,
    private readonly runtime: Runtime,
    private readonly bases: ApplyBases,
    private readonly installRequests: InstallRequests,
    private readonly changes: Changes,
  ) {}

  public async apply(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<
    | { kind: "applied"; changeId: string }
    | { kind: "blocked"; reason: string }
    | { kind: "conflict" | "rejected"; requestId: string }
  > {
    signal.throwIfAborted();
    const candidate = await this.candidates.load(claim);
    if (!candidate || !["draft", "ready_waiting_idle", "applied"].includes(candidate.state))
      throw new Error("Learning apply requires one admitted or draft candidate");
    if (candidate.state === "applied") {
      const existing = await this.installRequests.next(claim, candidate.candidateId);
      if (existing.kind !== "applied") throw new Error("Applied candidate lacks its install");
      return this.recordApplied(claim, candidate.candidateId, existing.requestId);
    }
    const current = await this.admitCurrent(claim, candidate, signal);
    if (candidate.state === "draft")
      await this.bases.recordAdmitted(claim, candidate.candidateId, current.basis);
    else {
      const saved = await this.bases.read(claim, candidate.candidateId);
      if (saved === null) throw new Error("Admitted candidate lost its apply basis");
      if (!sameAuthority(saved, current.basis))
        throw new Error("Skill learning apply authority changed before install");
    }
    signal.throwIfAborted();
    const request = await this.installRequests.next(claim, candidate.candidateId);
    if (request.kind === "conflict" || request.kind === "rejected")
      return { kind: request.kind, requestId: request.requestId };
    if (request.kind === "applied")
      return this.recordApplied(claim, candidate.candidateId, request.requestId);
    if (request.kind === "not_ready")
      throw new Error("Learning install task is not ready for a new attempt");
    let receipt: Awaited<ReturnType<Runtime["install"]>>;
    try {
      receipt = await this.runtime.install({
        claim,
        binding: current.binding,
        candidateId: candidate.candidateId,
        requestId: request.requestId,
        package: candidate.package,
        expectedBaseDigest: candidate.expectedBaseDigest,
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RuntimeMaintenanceUnknownError)
        return { kind: "blocked", reason: "unsettled" };
      if (error instanceof RuntimeMaintenanceRejectedError)
        return installRejectionIsResendable(error.code)
          ? { kind: "blocked", reason: "unsettled" }
          : { kind: "rejected", requestId: request.requestId };
      throw error;
    }
    if (receipt.outcome === "blocked") return { kind: "blocked", reason: receipt.blocked_reason };
    if (receipt.outcome === "preempted") return { kind: "blocked", reason: "preempted" };
    if (receipt.outcome === "conflict") return { kind: "conflict", requestId: request.requestId };
    if (receipt.observed_digest !== candidate.package.targetDigest)
      throw new Error("Runtime applied a different Skill content digest");
    return this.recordApplied(claim, candidate.candidateId, request.requestId);
  }

  private async recordApplied(
    claim: LearningTaskClaim,
    candidateId: string,
    requestId: string,
  ): Promise<{ kind: "applied"; changeId: string }> {
    const change = await this.changes.recordApplied({
      claim,
      candidateId,
      installRequestId: requestId,
    });
    return { kind: "applied", changeId: change.changeId };
  }

  private async admitCurrent(
    claim: LearningTaskClaim,
    candidate: Candidate,
    signal: AbortSignal,
  ): Promise<{ binding: Binding; basis: AutomaticApplyBasis }> {
    signal.throwIfAborted();
    const scope = {
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    };
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

/** The execution that admitted a candidate does not bind its install. */
function sameAuthority(saved: AutomaticApplyBasis, current: AutomaticApplyBasis): boolean {
  return (
    saved.policyRevision === current.policyRevision &&
    saved.packagePath === current.packagePath &&
    saved.expectedBaseDigest === current.expectedBaseDigest &&
    saved.targetDigest === current.targetDigest &&
    saved.evidenceIds.length === current.evidenceIds.length &&
    saved.evidenceIds.every((id, index) => id === current.evidenceIds[index])
  );
}
