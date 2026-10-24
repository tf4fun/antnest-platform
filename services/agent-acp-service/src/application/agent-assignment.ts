import { createHash } from "node:crypto";
import {
  AgentOwnershipLostError,
  ownershipScope,
  type AgentOwnershipScope,
} from "../domain/agent-ownership.js";
import type { PeerAvailabilityCapture } from "./peer-availability.js";
import type { PeerParticipationGuard } from "../ports/peer-participation.js";

/** Preference uses the complete pinned catalog, never a process-local healthy subset. */
export class AgentAssignment {
  readonly #members: readonly string[];
  public constructor(
    private readonly localMember: string,
    members: readonly string[],
    private readonly availability?: () => PeerAvailabilityCapture,
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

  public target(scope: AgentOwnershipScope): string {
    const preferred = this.preferred(scope);
    if (this.availability === undefined) return preferred;
    return this.targetInView(scope, this.availability());
  }

  public acquireGuard(scope: AgentOwnershipScope): PeerParticipationGuard {
    const view = this.availability?.();
    if (view === undefined || this.targetInView(scope, view) !== this.localMember)
      throw new AgentOwnershipLostError();
    return view.guard;
  }

  private targetInView(scope: AgentOwnershipScope, view: PeerAvailabilityCapture): string {
    const preferred = this.preferred(scope);
    const start = this.#members.indexOf(preferred);
    if (
      view.members.length !== this.#members.length ||
      view.members.some((member, index) => member.memberId !== this.#members[index])
    )
      throw new Error("Incomplete ACP availability catalog");
    const live = new Set(view.live.map((registration) => registration.member_id));
    if (view.members[start]?.state !== "stopped") return preferred;
    // Walk the original ring. Only a verified inactive member's partition moves;
    // a local timeout never edits the pinned catalog or creates a new hash ring.
    for (let offset = 0; offset < this.#members.length; offset++) {
      const member = this.#members[(start + offset) % this.#members.length]!;
      if (live.has(member)) return member;
    }
    throw new Error("ACP membership has no active participant");
  }

  public owns(scope: AgentOwnershipScope): boolean {
    return this.target(scope) === this.localMember;
  }
}
