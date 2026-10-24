import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import {
  authenticateFields,
  fields,
  readCredential,
  type Admission,
  type Receiver,
  type ServiceAuthentication,
} from "./service-authentication.js";
import { strictObject } from "./strict-json.js";

const invalid = () => new Error("acp_peer_configuration_invalid");
const memberId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
const catalog = z.strictObject({
  version: z.literal(1),
  cluster_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  members: z
    .array(z.strictObject({ member_id: memberId, origin: z.string().min(8).max(2048) }))
    .min(1)
    .max(64),
});

export type PeerMembership = Readonly<{
  clusterId: string;
  sha256: string;
  members: readonly Readonly<{ member_id: string; origin: string }>[];
}>;

export function parsePeerMembership(raw: Uint8Array, localMemberId: string): PeerMembership {
  try {
    const parsed = catalog.parse(strictObject(raw));
    const ids = new Set<string>();
    const origins = new Set<string>();
    for (const member of parsed.members) {
      const origin = new URL(member.origin);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.origin !== member.origin ||
        ids.has(member.member_id) ||
        origins.has(member.origin)
      )
        throw invalid();
      ids.add(member.member_id);
      origins.add(member.origin);
    }
    if (!ids.has(localMemberId)) throw invalid();
    const members = parsed.members.sort((a, b) =>
      a.member_id < b.member_id ? -1 : a.member_id > b.member_id ? 1 : 0,
    );
    // Object keys are in canonical lexical order; members have already been sorted.
    const canonical = JSON.stringify({
      cluster_id: parsed.cluster_id,
      members: members.map(({ member_id, origin }) => ({ member_id, origin })),
      version: 1,
    });
    return Object.freeze({
      clusterId: parsed.cluster_id,
      sha256: createHash("sha256").update(canonical).digest("hex"),
      members: Object.freeze(members.map((member) => Object.freeze(member))),
    });
  } catch {
    throw invalid();
  }
}

export function parsePeerReceiver(raw: Uint8Array, remoteMembers: readonly string[]): Receiver {
  try {
    const input = strictObject(raw);
    const allowed = new Set(remoteMembers);
    if (
      allowed.size !== remoteMembers.length ||
      allowed.size > 63 ||
      remoteMembers.some((id) => !memberId.safeParse(id).success) ||
      Object.keys(input).length !== allowed.size
    )
      throw invalid();
    const receiver: Receiver = new Map();
    for (const [source, hashes] of Object.entries(input)) {
      if (!allowed.has(source) || !Array.isArray(hashes) || hashes.length < 1 || hashes.length > 2)
        throw invalid();
      for (const hash of hashes as unknown[]) {
        if (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(hash) || receiver.has(hash))
          throw invalid();
        receiver.set(hash, source);
      }
    }
    return receiver;
  } catch {
    throw invalid();
  }
}

/** Separate member credentials never extend ordinary logical-service grants. */
export class PeerAuthentication {
  public readonly memberId: string;
  public readonly membership: PeerMembership;
  private readonly receiver: Receiver;
  private readonly remoteMembers: readonly string[];
  private readonly fetchers = new Map<string, typeof fetch>();
  private readonly workload: ServiceAuthentication;

  public constructor(options: {
    memberId: string;
    membershipFile: string;
    callersFile: string;
    tokenDirectory: string;
    workload: ServiceAuthentication;
  }) {
    if (options.workload.service !== "agent-acp-service") throw invalid();
    this.memberId = options.memberId;
    this.workload = options.workload;
    this.membership = parsePeerMembership(
      readCredential(options.membershipFile, 256 * 1024),
      options.memberId,
    );
    this.remoteMembers = this.membership.members
      .filter((member) => member.member_id !== options.memberId)
      .map((member) => member.member_id);
    this.receiver = parsePeerReceiver(
      readCredential(options.callersFile, 16 * 1024),
      this.remoteMembers,
    );
    if (!options.tokenDirectory) throw invalid();
    for (const member of this.membership.members) {
      if (member.member_id === options.memberId) continue;
      this.fetchers.set(
        member.member_id,
        this.workload.fetchForPeer(member.origin, join(options.tokenDirectory, member.member_id)),
      );
    }
  }

  public get serverTLS() {
    return this.workload.serverTLS;
  }

  public authenticate(request: IncomingMessage): Admission {
    if (this.workload.runtimeTransport().authMode === "mtls") {
      const transport = this.workload.authenticate(request, ["agent-acp-service"]);
      if (transport.code !== null) return transport;
    }
    return authenticateFields(this.receiver, fields(request), this.remoteMembers);
  }

  public fetchFor(memberId: string): typeof fetch {
    const send = this.fetchers.get(memberId);
    if (send === undefined) throw invalid();
    return send;
  }
}
