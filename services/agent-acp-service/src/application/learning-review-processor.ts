import { createHash } from "node:crypto";

import {
  buildLearningCandidatePackage,
  learningSkillTextDigest,
  type LearningCandidatePackage,
} from "../domain/learning-candidate-package.js";
import type { LearningEvidence } from "../domain/learning-evidence.js";
import type { ManagedSkillIdentity } from "../domain/learning-apply-admission.js";
import type { LearningReviewDecision } from "../domain/learning-review-proposal.js";
import { learningPolicySchema } from "../domain/learning-policy.js";
import type { LearningScanScope, LearningTaskClaim } from "../domain/learning-scan.js";
import type { RuntimeInformation } from "../domain/runtime-information.js";
import type { RuntimeBinding } from "../domain/types.js";

type Review = {
  execute(input: {
    claim: LearningTaskClaim;
    signal: AbortSignal;
    existingSkills: readonly { name: string; description: string; content?: string }[];
  }): Promise<LearningReviewDecision | null>;
};
type Evidence = {
  loadRecorded(claim: LearningTaskClaim): Promise<LearningEvidence>;
  readAndRecord(claim: LearningTaskClaim): Promise<LearningEvidence>;
};
type Candidates = {
  load(claim: LearningTaskClaim): Promise<{ candidateId: string; state: string } | null>;
  record(input: {
    claim: LearningTaskClaim;
    candidateId: string;
    package: LearningCandidatePackage;
    expectedBaseDigest: string | null;
    baseSkillText?: string;
  }): Promise<{ candidateId: string; state: string }>;
};
type Managed = {
  read(scope: LearningScanScope, packagePath: string): Promise<ManagedSkillIdentity | null>;
  list(scope: LearningScanScope): Promise<ManagedSkillIdentity[]>;
};
type Outcomes = {
  recordModelSkip(claim: LearningTaskClaim): Promise<{ state: "skipped" }>;
  recordPinnedProposalSkip(
    claim: LearningTaskClaim,
    packagePath: string,
  ): Promise<{ state: "skipped" }>;
};
type Binding = RuntimeBinding;
type Runtime = {
  current(claim: LearningTaskClaim): Promise<Binding | null>;
  readBinding(
    binding: Binding,
    signal: AbortSignal,
  ): Promise<Pick<RuntimeInformation, "executionId" | "skills" | "warnings" | "truncated">>;
  readPersonalSkill(binding: Binding, packagePath: string, signal: AbortSignal): Promise<string>;
};

export class LearningReviewProcessor {
  public constructor(
    private readonly review: Review,
    private readonly evidence: Evidence,
    private readonly candidates: Candidates,
    private readonly managed: Managed,
    private readonly outcomes: Outcomes,
    private readonly runtime: Runtime,
  ) {}

  public async process(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<
    | { kind: "candidate"; candidateId: string; state: string }
    | { kind: "skipped" }
    | { kind: "undecided" }
  > {
    signal.throwIfAborted();
    const existing = await this.candidates.load(claim);
    if (existing) return { kind: "candidate", ...existing };
    const frozenPolicy = learningPolicySchema.parse(claim.frozenPolicy);
    const scope = {
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    };
    const binding = await this.runtime.current(claim);
    if (binding === null) throw new Error("Learning Runtime binding is unavailable");
    const [registered, information, sourceEvidence] = await Promise.all([
      this.managed.list(scope),
      this.runtime.readBinding(binding, signal),
      this.evidence.readAndRecord(claim),
    ]);
    if (
      information.executionId !== binding.executionId ||
      information.truncated ||
      information.warnings.length > 0
    )
      throw new Error("Learning Runtime Skill inventory is incomplete");
    const eligible = registered
      .filter(
        (item) =>
          item.state === "active" &&
          item.origin === "auto_generated" &&
          !frozenPolicy.pinned_paths.includes(item.packagePath),
      )
      .flatMap((item) => {
        const skill = information.skills.find(
          (found) =>
            found.source === "personal" &&
            found.path.root === "workspace" &&
            found.path.path === `${item.packagePath}/SKILL.md` &&
            item.packagePath === `.antnest/skills/${found.name}`,
        );
        return skill === undefined ? [] : [{ name: skill.name, description: skill.description }];
      });
    const selected = selectRelatedSkills(eligible, sourceEvidence);
    const currentByPath = new Map<string, { skillText: string; digest: string }>();
    const existingSkills: { name: string; description: string; content?: string }[] = [];
    let contentBytes = 0;
    for (const skill of eligible) {
      if (!selected.has(skill.name)) {
        existingSkills.push(skill);
        continue;
      }
      const packagePath = `.antnest/skills/${skill.name}`;
      const current = registered.find((item) => item.packagePath === packagePath);
      if (current === undefined) throw new Error("Learning Skill inventory is inconsistent");
      const skillText = await this.runtime.readPersonalSkill(binding, packagePath, signal);
      const digest = learningSkillTextDigest(skillText);
      if (digest !== current.lastDigest)
        throw new Error("Learning Skill current content differs from its managed digest");
      const nextBytes = Buffer.byteLength(skillText, "utf8");
      if (contentBytes + nextBytes > 24 * 1024) {
        existingSkills.push(skill);
        continue;
      }
      contentBytes += nextBytes;
      currentByPath.set(packagePath, { skillText, digest });
      existingSkills.push({ ...skill, content: skillText });
    }
    const decision = await this.review.execute({ claim, signal, existingSkills });
    signal.throwIfAborted();
    if (decision === null) return { kind: "undecided" };
    if (decision.decision === "skip") {
      await this.outcomes.recordModelSkip(claim);
      return { kind: "skipped" };
    }
    const recorded = await this.evidence.loadRecorded(claim);
    if (recorded.sourceRunId !== claim.sourceRunId)
      throw new Error("Learning proposal evidence belongs to another Run");
    const packagePath = `.antnest/skills/${decision.name}`;
    if (frozenPolicy.pinned_paths.includes(packagePath)) {
      await this.outcomes.recordPinnedProposalSkip(claim, packagePath);
      return { kind: "skipped" };
    }
    const managed = await this.managed.read(scope, packagePath);
    if (
      managed !== null &&
      (managed.organizationId !== scope.organizationId ||
        managed.agentId !== scope.agentId ||
        managed.ownerId !== scope.ownerId ||
        managed.packagePath !== packagePath ||
        managed.state !== "active" ||
        !/^sha256:[0-9a-f]{64}$/u.test(managed.lastDigest))
    )
      throw new Error("Learning proposal managed path identity is unavailable");
    let current: { skillText: string; digest: string } | undefined;
    if (managed !== null) {
      current = currentByPath.get(packagePath);
      if (current === undefined)
        throw new Error("Learning Skill update requires its current contents before proposing");
      if (current.digest !== managed.lastDigest)
        throw new Error("Learning Skill current content differs from its managed digest");
    }
    const packageValue = buildLearningCandidatePackage(decision, recorded, current);
    signal.throwIfAborted();
    const saved = await this.candidates.record({
      claim,
      candidateId: candidateId(claim),
      package: packageValue,
      expectedBaseDigest: managed?.lastDigest ?? null,
      ...(current === undefined ? {} : { baseSkillText: current.skillText }),
    });
    return { kind: "candidate", ...saved };
  }
}

function selectRelatedSkills(
  skills: readonly { name: string; description: string }[],
  evidence: LearningEvidence,
): Set<string> {
  if (skills.length === 1) return new Set([skills[0]!.name]);
  const trusted = evidence.items
    .filter((item) => item.kind !== "untrusted_material")
    .map((item) => item.text.toLowerCase())
    .join(" ");
  return new Set(
    skills
      .map((skill) => ({
        name: skill.name,
        score: [
          ...new Set(
            skill.name.split("-").concat(skill.description.toLowerCase().split(/[^a-z0-9]+/u)),
          ),
        ]
          .filter((word) => word.length >= 4)
          .filter((word) => trusted.includes(word)).length,
      }))
      .filter((skill) => skill.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 2)
      .map((skill) => skill.name),
  );
}

function candidateId(claim: LearningTaskClaim): string {
  return `candidate_${createHash("sha256")
    .update(JSON.stringify([claim.taskId, claim.claimId, claim.generation]))
    .digest("hex")}`;
}
