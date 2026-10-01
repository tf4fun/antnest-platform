import {
  validateLearningCandidatePackage,
  type LearningCandidatePackage,
} from "./learning-candidate-package.js";
import { learningPolicySchema, type LearningPolicy } from "./learning-policy.js";
import type { RuntimeInformation } from "./runtime-information.js";
import type { LearningTaskClaim } from "./learning-scan.js";
import { LearningPolicyChangedError } from "./learning-maintenance-errors.js";

export type ManagedSkillIdentity = {
  organizationId: string;
  agentId: string;
  ownerId: string;
  packagePath: string;
  origin: "auto_generated" | "adopted";
  state: "active" | "paused";
  lastDigest: string;
};

export type AutomaticApplyBasis = {
  kind: "policy";
  policyRevision: string;
  packagePath: string;
  expectedBaseDigest: string | null;
  targetDigest: string;
  evidenceIds: string[];
  executionId: string;
};

export function admitAutomaticSkillCandidate(input: {
  claim: LearningTaskClaim;
  policy: LearningPolicy;
  candidate: LearningCandidatePackage;
  expectedBaseDigest: string | null;
  managed: ManagedSkillIdentity | null;
  information: RuntimeInformation;
  executionId: string;
}): AutomaticApplyBasis {
  validateLearningCandidatePackage(input.candidate);
  const frozen = learningPolicySchema.parse(input.claim.frozenPolicy);
  const current = learningPolicySchema.parse(input.policy);
  if (current.mode !== "automatic" || current.revision !== frozen.revision)
    throw new LearningPolicyChangedError();
  if (
    current.organization_id !== input.claim.organizationId ||
    current.agent_id !== input.claim.agentId ||
    current.owner_principal_id !== input.claim.ownerId ||
    frozen.organization_id !== input.claim.organizationId ||
    frozen.agent_id !== input.claim.agentId ||
    frozen.owner_principal_id !== input.claim.ownerId ||
    current.pinned_paths.includes(input.candidate.packagePath) ||
    input.information.executionId !== input.executionId ||
    input.information.truncated ||
    input.information.warnings.some(
      (warning) =>
        warning.path.root === "system_skills" ||
        warning.path.path === ".antnest/skills" ||
        warning.path.path.startsWith(".antnest/skills/"),
    )
  )
    throw new Error("Automatic Skill apply authority is unavailable");
  if (input.expectedBaseDigest !== null && !/^sha256:[0-9a-f]{64}$/u.test(input.expectedBaseDigest))
    throw new Error("Automatic Skill base digest is invalid");

  const personal = input.information.skills.filter((skill) => skill.source === "personal");
  if (
    personal.length > 32 ||
    personal.some(
      (skill) =>
        skill.path.root !== "workspace" ||
        skill.path.path !== `.antnest/skills/${skill.name}/SKILL.md`,
    )
  )
    throw new Error("Personal Skill inventory is not complete and canonical");
  const name = input.candidate.packagePath.slice(".antnest/skills/".length);
  if (input.information.skills.some((skill) => skill.source === "system" && skill.name === name))
    throw new Error("System Skill name collides with the learning candidate");
  const matches = personal.filter(
    (skill) => skill.path.path === `${input.candidate.packagePath}/SKILL.md`,
  );
  if (matches.length > 1) throw new Error("Personal Skill path is ambiguous");

  if (input.managed === null) {
    if (
      !current.scope.auto_generated_personal ||
      current.scope.adopted_paths.includes(input.candidate.packagePath) ||
      input.expectedBaseDigest !== null ||
      matches.length !== 0 ||
      personal.length >= 32
    )
      throw new Error("Automatic Skill creation is outside the managed scope");
  } else {
    const managed = input.managed;
    if (
      managed.organizationId !== input.claim.organizationId ||
      managed.agentId !== input.claim.agentId ||
      managed.ownerId !== input.claim.ownerId ||
      managed.packagePath !== input.candidate.packagePath ||
      managed.state !== "active" ||
      !/^sha256:[0-9a-f]{64}$/u.test(managed.lastDigest) ||
      input.expectedBaseDigest !== managed.lastDigest ||
      matches.length !== 1 ||
      (managed.origin === "auto_generated" && !current.scope.auto_generated_personal) ||
      (managed.origin === "adopted" &&
        !current.scope.adopted_paths.includes(input.candidate.packagePath))
    )
      throw new Error("Automatic Skill update has no current managed identity");
  }
  return {
    kind: "policy",
    policyRevision: current.revision,
    packagePath: input.candidate.packagePath,
    expectedBaseDigest: input.expectedBaseDigest,
    targetDigest: input.candidate.targetDigest,
    evidenceIds: [...input.candidate.evidenceIds],
    executionId: input.executionId,
  };
}
