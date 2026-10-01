export const learningBlockReasons = [
  "writer_present",
  "unknown_effect",
  "model_unavailable",
  "runtime_unavailable",
  "review_inconclusive",
] as const;
export type LearningStatus = {
  agentId: string;
  blocked: null | {
    reason: (typeof learningBlockReasons)[number];
    skillName?: string;
    sourceSessionId?: string;
    sourceRunId?: string;
  };
};
type Identity = { organizationId: string; agentId: string; principalId: string };
type Scope = { organizationId: string; agentId: string; ownerId: string };
type Access = {
  withAccess(identity: Identity, work: () => Promise<LearningStatus>): Promise<LearningStatus>;
};
type Repository = { read(scope: Scope): Promise<LearningStatus> };

/** Authorization precedes even an empty status read. */
export class LearningStatusReader {
  public constructor(
    private readonly access: Access,
    private readonly repository: Repository,
  ) {}
  public read(identity: Identity): Promise<LearningStatus> {
    return this.access.withAccess(identity, () =>
      this.repository.read({
        organizationId: identity.organizationId,
        agentId: identity.agentId,
        ownerId: identity.principalId,
      }),
    );
  }
}
