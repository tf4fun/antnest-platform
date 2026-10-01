import type { LearningChangeItem } from "../adapters/postgres/learning-change-read.js";
import type { LearningChangeCursor } from "../domain/learning-change-cursor.js";

type Identity = { organizationId: string; agentId: string; principalId: string };
type Scope = { organizationId: string; agentId: string; ownerId: string };
type Position = { kind: "latest" } | { kind: "after" | "before"; sequence: string };
type Page = {
  sealedSequence: string;
  items: LearningChangeItem[];
  hasMoreOlder: boolean;
  hasMoreForward: boolean;
};
type Access = {
  withAccess(identity: Identity, work: () => Promise<Page>): Promise<Page>;
};
type Repository = { page(scope: Scope, position: Position, limit: number): Promise<Page> };

/** Authenticated, direction-specific pagination over committed learning changes. */
export class LearningChangeReader {
  public constructor(
    private readonly access: Access,
    private readonly repository: Repository,
    private readonly cursor: LearningChangeCursor,
  ) {}

  public async list(
    identity: Identity,
    input: { after?: string; before?: string },
    limit: number,
  ): Promise<{
    items: LearningChangeItem[];
    nextCursor: string;
    olderCursor: string | null;
    sealedCursor: string;
  }> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      (input.after !== undefined && input.before !== undefined)
    )
      throw new Error("Invalid learning change page request");
    const scope: Scope = {
      organizationId: identity.organizationId,
      agentId: identity.agentId,
      ownerId: identity.principalId,
    };
    const position: Position =
      input.after !== undefined
        ? { kind: "after", sequence: this.cursor.decode(input.after, scope, "after") }
        : input.before !== undefined
          ? { kind: "before", sequence: this.cursor.decode(input.before, scope, "before") }
          : { kind: "latest" };
    const result = await this.access.withAccess(identity, () =>
      this.repository.page(scope, position, limit),
    );
    const sealedCursor = this.cursor.encode(scope, "after", result.sealedSequence);
    const latestItem = result.items.at(-1);
    const oldestItem = result.items[0];
    return {
      items: result.items,
      sealedCursor,
      nextCursor:
        position.kind === "after" && result.hasMoreForward && latestItem !== undefined
          ? this.cursor.encode(scope, "after", latestItem.sequence)
          : sealedCursor,
      olderCursor:
        position.kind !== "after" && result.hasMoreOlder && oldestItem !== undefined
          ? this.cursor.encode(scope, "before", oldestItem.sequence)
          : null,
    };
  }
}
