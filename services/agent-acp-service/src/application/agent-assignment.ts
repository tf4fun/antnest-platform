import { createHash } from "node:crypto";
import { ownershipScope, type AgentOwnershipScope } from "../domain/agent-ownership.js";

/** Preference uses the complete pinned catalog, never a process-local healthy subset. */
export class AgentAssignment {
  readonly #members: readonly string[];
  public constructor(
    private readonly localMember: string,
    members: readonly string[],
  ) {
    const runtimeMembers: unknown = members;
    if (
      !Array.isArray(runtimeMembers) ||
      members.length < 1 ||
      members.length > 64 ||
      members.some(
        (member) =>
          typeof member !== "string" ||
          member.length > 64 ||
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.exec(member)?.[0] !== member,
      ) ||
      new Set(members).size !== members.length ||
      !members.includes(localMember)
    )
      throw new TypeError("Invalid fixed Agent membership");
    this.#members = Object.freeze([...members].sort());
    Object.freeze(this);
  }

  public preferred(input: AgentOwnershipScope): string {
    const scope = ownershipScope(input);
    const digest = createHash("sha256")
      .update(JSON.stringify([scope.organizationId, scope.agentId]), "utf8")
      .digest("hex");
    return this.#members[Number(BigInt(`0x${digest}`) % BigInt(this.#members.length))]!;
  }

  public owns(scope: AgentOwnershipScope): boolean {
    return this.preferred(scope) === this.localMember;
  }
}
