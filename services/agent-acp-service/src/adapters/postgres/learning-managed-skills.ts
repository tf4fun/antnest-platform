import type { ManagedSkillIdentity } from "../../domain/learning-apply-admission.js";
import type { LearningScanScope } from "../../domain/learning-scan.js";
import { learningScopedId } from "../../domain/learning-policy.js";
import type { PostgresKernel } from "./kernel.js";

type Row = {
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  package_path: string;
  origin: "auto_generated" | "adopted";
  state: "active" | "paused";
  last_digest: string;
};

export class PostgresLearningManagedSkills {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async list(scope: LearningScanScope): Promise<ManagedSkillIdentity[]> {
    if (
      !learningScopedId.test(scope.organizationId) ||
      !learningScopedId.test(scope.agentId) ||
      !learningScopedId.test(scope.ownerId)
    )
      throw new Error("Invalid managed Skill listing scope");
    const result = await this.kernel.read<Row>(
      `SELECT organization_id,agent_id,owner_principal_id,package_path,origin,state,last_digest
       FROM learning_managed_skills WHERE organization_id=$1 AND agent_id=$2
         AND owner_principal_id=$3 ORDER BY package_path LIMIT 33`,
      [scope.organizationId, scope.agentId, scope.ownerId],
    );
    if (result.rows.length > 32) throw new Error("Managed Skill inventory exceeds Runtime limit");
    return result.rows.map((saved) => parseManagedSkill(saved));
  }

  public async read(
    scope: LearningScanScope,
    packagePath: string,
  ): Promise<ManagedSkillIdentity | null> {
    if (
      !learningScopedId.test(scope.organizationId) ||
      !learningScopedId.test(scope.agentId) ||
      !learningScopedId.test(scope.ownerId) ||
      !/^\.antnest\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(packagePath)
    )
      throw new Error("Invalid managed Skill lookup scope");
    const result = await this.kernel.read<Row>(
      `SELECT organization_id,agent_id,
      owner_principal_id,package_path,origin,state,last_digest
      FROM learning_managed_skills WHERE organization_id=$1 AND agent_id=$2
        AND owner_principal_id=$3 AND package_path=$4`,
      [scope.organizationId, scope.agentId, scope.ownerId, packagePath],
    );
    const saved = result.rows[0];
    if (!saved) return null;
    return parseManagedSkill(saved);
  }
}

function parseManagedSkill(saved: Row): ManagedSkillIdentity {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(saved.last_digest) ||
    !["auto_generated", "adopted"].includes(saved.origin) ||
    !["active", "paused"].includes(saved.state) ||
    !/^\.antnest\/skills\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(saved.package_path)
  )
    throw new Error("Stored managed Skill identity is invalid");
  return {
    organizationId: saved.organization_id,
    agentId: saved.agent_id,
    ownerId: saved.owner_principal_id,
    packagePath: saved.package_path,
    origin: saved.origin,
    state: saved.state,
    lastDigest: saved.last_digest,
  };
}
