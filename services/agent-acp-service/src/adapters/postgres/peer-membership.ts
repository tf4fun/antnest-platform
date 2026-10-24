import { isDeepStrictEqual } from "node:util";
import { parsePeerMembership, type PeerMembership } from "../peer-authentication.js";
import type { PostgresKernel } from "./kernel.js";

type Catalog = { version: 1; cluster_id: string; members: PeerMembership["members"] };
type Pin = { cluster_id: string; membership_sha256: string; catalog: Catalog };
const conflict = () => new Error("acp_peer_membership_conflict");

/** Pin the complete roster, never just a cluster-specific row that can be replaced. */
export class PostgresPeerMembership {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async assertPinned(
    membership?: PeerMembership,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    // Copy and recompute before the first asynchronous boundary. The caller's
    // digest or a later mutation cannot reinterpret a waiting initialization.
    const expected = membership === undefined ? undefined : capture(membership);
    await this.kernel.transaction(
      async (client) => {
        if (expected !== undefined)
          await client.query(
            "INSERT INTO acp_peer_membership(id,cluster_id,membership_sha256,catalog) VALUES(1,$1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING",
            [expected.cluster_id, expected.membership_sha256, JSON.stringify(expected.catalog)],
          );
        // A separate READ COMMITTED statement sees the concurrent winner after
        // ON CONFLICT has waited for its real commit.
        const result = await client.query<Pin>(
          "SELECT cluster_id,membership_sha256,catalog FROM acp_peer_membership WHERE id=1 FOR SHARE",
        );
        if (expected === undefined) {
          if (result.rowCount !== 0) throw conflict();
          return;
        }
        if (result.rowCount !== 1 || !isDeepStrictEqual(result.rows[0], expected)) throw conflict();
      },
      { timeoutMs: options.timeoutMs ?? 10000 },
    );
  }
}

function capture(input: PeerMembership): Pin {
  try {
    const parsed = parsePeerMembership(
      Buffer.from(
        JSON.stringify({ version: 1, cluster_id: input.clusterId, members: input.members }),
      ),
      input.members[0]?.member_id ?? "",
    );
    if (parsed.sha256 !== input.sha256) throw new Error();
    return {
      cluster_id: parsed.clusterId,
      membership_sha256: parsed.sha256,
      catalog: { version: 1, cluster_id: parsed.clusterId, members: parsed.members },
    };
  } catch {
    throw new Error("acp_peer_configuration_invalid");
  }
}
