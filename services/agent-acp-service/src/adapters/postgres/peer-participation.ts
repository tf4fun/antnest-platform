import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { DomainError } from "../../domain/errors.js";
import {
  parseOwnerRegistration,
  type OwnerRegistration,
} from "../../application/owner-incarnation.js";
import type {
  PeerParticipationCapture,
  PeerParticipationGuard,
} from "../../ports/peer-participation.js";
import type { PostgresKernel } from "./kernel.js";

const unavailable = () =>
  new DomainError("configuration_unavailable", "ACP participation changed or is unavailable");
const maxRevision = 9223372036854775807n;
function guard(input: PeerParticipationGuard): PeerParticipationGuard {
  const { membershipSha256, revision } = input;
  if (
    !/^[a-f0-9]{64}$/u.test(membershipSha256) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(revision) ||
    BigInt(revision) > maxRevision
  )
    throw unavailable();
  return Object.freeze({ membershipSha256, revision });
}

/** Same-connection guard; callers retain this lock through their own final commit. */
export async function lockPeerParticipation(
  client: PoolClient,
  input: PeerParticipationGuard,
): Promise<void> {
  const expected = guard(input);
  const result = await client.query<{ revision: string; membership_sha256: string }>(
    `SELECT p.revision::text,m.membership_sha256 FROM acp_peer_participation p
     JOIN acp_peer_membership m ON m.id=p.id WHERE p.id=1 FOR SHARE OF p`,
  );
  const row = result.rows[0];
  if (row?.membership_sha256 !== expected.membershipSha256 || row.revision !== expected.revision)
    throw unavailable();
}

export class PostgresPeerParticipation {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly membershipSha256: string,
  ) {
    guard({ membershipSha256, revision: "0" });
  }
  private async head(client: PoolClient, mode: "SHARE" | "UPDATE") {
    const pinned = await client.query<{
      membership_sha256: string;
      catalog: { members: { member_id: string }[] };
    }>("SELECT membership_sha256,catalog FROM acp_peer_membership WHERE id=1");
    const membership = pinned.rows[0];
    if (membership?.membership_sha256 !== this.membershipSha256) throw unavailable();
    await client.query(
      "INSERT INTO acp_peer_participation(id,revision) VALUES(1,0) ON CONFLICT(id) DO NOTHING",
    );
    const result = await client.query<{ revision: string }>(
      `SELECT revision::text FROM acp_peer_participation WHERE id=1 FOR ${mode}`,
    );
    const revision = result.rows[0]?.revision;
    if (revision === undefined) throw unavailable();
    guard({ membershipSha256: this.membershipSha256, revision });
    return { revision, members: membership.catalog.members };
  }
  public async join(input: OwnerRegistration): Promise<void> {
    const original = parseOwnerRegistration(input);
    await this.kernel.transaction(
      async (client) => {
        const { revision, members } = await this.head(client, "UPDATE");
        if (!members.some((member) => member.member_id === original.member_id)) throw unavailable();
        const existing = await client.query<OwnerRegistration>(
          `SELECT registration_id,member_id,incarnation_id FROM acp_peer_participants
         WHERE registration_id=$1 OR (member_id=$2 AND incarnation_id=$3)`,
          [original.registration_id, original.member_id, original.incarnation_id],
        );
        if (existing.rows.length) {
          if (existing.rows.length !== 1 || !isDeepStrictEqual(existing.rows[0], original))
            throw unavailable();
          return;
        }
        if (BigInt(revision) === maxRevision) throw unavailable();
        const next = String(BigInt(revision) + 1n);
        await client.query(
          `INSERT INTO acp_peer_participants(id,registration_id,member_id,incarnation_id,participation_revision)
         VALUES(1,$1,$2,$3,$4::bigint)`,
          [original.registration_id, original.member_id, original.incarnation_id, next],
        );
        await client.query("UPDATE acp_peer_participation SET revision=$1::bigint WHERE id=1", [
          next,
        ]);
      },
      { timeoutMs: 10000 },
    );
  }
  public capture(): Promise<PeerParticipationCapture> {
    return this.kernel.transaction(
      async (client) => {
        const { revision } = await this.head(client, "SHARE");
        const result = await client.query<OwnerRegistration>(
          "SELECT registration_id,member_id,incarnation_id FROM acp_peer_participants ORDER BY member_id,registration_id",
        );
        return Object.freeze({
          membershipSha256: this.membershipSha256,
          revision,
          registrations: Object.freeze(result.rows.map(parseOwnerRegistration)),
        });
      },
      { timeoutMs: 10000 },
    );
  }
  public assert(
    input: PeerParticipationGuard,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    const expected = guard(input);
    if (expected.membershipSha256 !== this.membershipSha256) return Promise.reject(unavailable());
    return this.kernel.transaction((client) => lockPeerParticipation(client, expected), {
      timeoutMs: options.timeoutMs ?? 10000,
    });
  }
}
