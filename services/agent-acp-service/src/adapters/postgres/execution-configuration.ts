import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
  type ExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../domain/execution-configuration.js";
import { DomainError } from "../../domain/errors.js";
import { ownershipFence, type AgentOwnershipFence } from "../../domain/agent-ownership.js";
import {
  InvalidExecutionAuthorityError,
  type ExecutionConfigurationRepository,
} from "../../ports/execution-configuration.js";
import type { PostgresKernel } from "./kernel.js";
import type { SecretBox } from "./secret-box.js";
import {
  lockRuntimeBarrierOrganization,
  retireReplacedRuntimeBarriers,
} from "./runtime-barrier.js";

type StoredAuthority = {
  organization_id: string;
  revision: string;
  configuration: unknown;
  authority_version: number | null;
  authority_nonce: Buffer | null;
  authority_ciphertext: Buffer | null;
};

const authorityColumns =
  "organization_id, revision, configuration, authority_version, authority_nonce, authority_ciphertext";

const associatedData = (organizationId: string, revision: number): string =>
  JSON.stringify(["agent-acp-service/execution-authority", 1, organizationId, revision]);

function conflict(): DomainError {
  return new DomainError("configuration_conflict", "Execution configuration identity changed");
}

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.strictObject({
  providers: z.array(
    z.strictObject({
      connection_id: identifier,
      routing: z.strictObject({
        provider_key: z.enum(["deepseek", "openrouter"]),
        request_protocol: z.literal("openai_chat_completions"),
        base_url: z.url(),
      }),
      credentials: z.array(z.strictObject({ revision: identifier, digest })),
    }),
  ),
  runtimes: z.array(
    z.strictObject({
      connection_id: identifier,
      agent_id: identifier,
      runtime_revision: identifier,
      digest: digest.optional(),
    }),
  ),
});
const envelopeSchema = z.strictObject({
  configuration: z.unknown(),
  identities: identitySchema,
});
type Identities = z.infer<typeof identitySchema>;
type Authority = { configuration: ExecutionConfiguration; identities: Identities };
const fingerprint = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function requireUniqueIdentities(identities: Identities): void {
  const unique = (values: string[]): boolean => new Set(values).size === values.length;
  if (
    !unique(identities.providers.map((provider) => provider.connection_id)) ||
    !unique(identities.runtimes.map((runtime) => runtime.connection_id)) ||
    identities.providers.some(
      (provider) => !unique(provider.credentials.map((credential) => credential.revision)),
    )
  )
    throw new InvalidExecutionAuthorityError();
}

// Only the latest configuration is executable. Encrypted identity fingerprints
// survive removal/closure so a later publication cannot reuse an old identity
// with different credentials, including after every process has restarted.
function retainIdentities(previous: Identities, incoming: ExecutionConfiguration): Identities {
  const identities = structuredClone(previous);
  const providers = new Map(
    identities.providers.map((provider) => [provider.connection_id, provider]),
  );
  for (const provider of incoming.providers) {
    const routing = {
      provider_key: provider.provider_key,
      request_protocol: provider.request_protocol,
      base_url: provider.base_url,
    };
    let identity = providers.get(provider.connection_id);
    if (identity === undefined) {
      identity = { connection_id: provider.connection_id, routing, credentials: [] };
      identities.providers.push(identity);
      providers.set(identity.connection_id, identity);
    } else if (!isDeepStrictEqual(identity.routing, routing)) throw conflict();
    if ("credential" in provider) {
      const next = {
        revision: provider.credential_revision,
        digest: fingerprint(provider.credential.secret),
      };
      const before = identity.credentials.find(
        (credential) => credential.revision === next.revision,
      );
      if (before === undefined) identity.credentials.push(next);
      else if (before.digest !== next.digest) throw conflict();
    }
  }
  const runtimes = new Map(identities.runtimes.map((runtime) => [runtime.connection_id, runtime]));
  for (const agent of incoming.agents) {
    const runtime = agent.runtime;
    if (runtime?.connection_id === undefined) continue;
    let identity = runtimes.get(runtime.connection_id);
    if (identity === undefined) {
      identity = {
        connection_id: runtime.connection_id,
        agent_id: agent.agent_id,
        runtime_revision: runtime.runtime_revision,
      };
      identities.runtimes.push(identity);
      runtimes.set(identity.connection_id, identity);
    } else if (
      identity.agent_id !== agent.agent_id ||
      identity.runtime_revision !== runtime.runtime_revision
    )
      throw conflict();
    if (runtime.credential !== undefined) {
      const next = fingerprint(runtime.credential.token);
      if (identity.digest === undefined) identity.digest = next;
      else if (identity.digest !== next) throw conflict();
    }
  }
  return identities;
}

export class PostgresExecutionConfiguration implements ExecutionConfigurationRepository {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly box: SecretBox,
  ) {}

  public async load(organizationId: string): Promise<PublicExecutionConfiguration | null> {
    const result = await this.kernel.query<{ configuration: unknown }>(
      "SELECT configuration FROM execution_configurations WHERE organization_id = $1",
      [organizationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parsePublicExecutionConfiguration(row.configuration);
  }

  public async listOrganizations(): Promise<string[]> {
    const result = await this.kernel.query<{ organization_id: string }>(
      "SELECT organization_id FROM execution_configurations ORDER BY organization_id",
    );
    return result.rows.map((row) => row.organization_id);
  }

  public async loadAuthority(organizationId: string): Promise<ExecutionConfiguration | null> {
    // Dependency errors must retain their global meaning during startup.
    const result = await this.kernel.query<StoredAuthority>(
      `SELECT ${authorityColumns} FROM execution_configurations WHERE organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : (this.openAuthority(row)?.configuration ?? null);
  }

  /** Read the authenticated private payload under the captured Agent lease. */
  public async loadOwnedAuthority(
    input: AgentOwnershipFence,
  ): Promise<ExecutionConfiguration | null> {
    const fence = ownershipFence(input);
    return this.kernel.agentTransaction(
      fence,
      async (client) => {
        const result = await client.query<StoredAuthority>(
          `SELECT ${authorityColumns} FROM execution_configurations WHERE organization_id = $1`,
          [fence.organizationId],
        );
        const row = result.rows[0];
        return row === undefined ? null : (this.openAuthority(row)?.configuration ?? null);
      },
      { organizationBarrier: true },
    );
  }

  private openAuthority(row: StoredAuthority): Authority | null {
    if (
      row.authority_version === null &&
      row.authority_nonce === null &&
      row.authority_ciphertext === null
    )
      return null;
    try {
      const revision = Number(row.revision);
      if (
        row.authority_version !== 1 ||
        !Buffer.isBuffer(row.authority_nonce) ||
        !Buffer.isBuffer(row.authority_ciphertext) ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new InvalidExecutionAuthorityError();
      const envelope = envelopeSchema.parse(
        this.box.open<unknown>(
          { nonce: row.authority_nonce, ciphertext: row.authority_ciphertext },
          associatedData(row.organization_id, revision),
        ),
      );
      const configuration = parseExecutionConfiguration(envelope.configuration);
      requireUniqueIdentities(envelope.identities);
      const projection = parsePublicExecutionConfiguration(row.configuration);
      if (
        configuration.organization_id !== row.organization_id ||
        configuration.revision !== revision ||
        !isDeepStrictEqual(publicExecutionConfiguration(configuration), projection) ||
        !isDeepStrictEqual(
          retainIdentities(envelope.identities, configuration),
          envelope.identities,
        )
      )
        throw new InvalidExecutionAuthorityError();
      return { configuration, identities: envelope.identities };
    } catch {
      // Do not retain crypto/parser causes or decrypted payloads in errors.
      throw new InvalidExecutionAuthorityError();
    }
  }

  public async save(
    input: ExecutionConfiguration,
    expectedRevision: number | null,
  ): Promise<boolean> {
    const incoming = parseExecutionConfiguration(input);
    const projection = publicExecutionConfiguration(incoming);
    return this.kernel.transaction(async (client) => {
      await lockRuntimeBarrierOrganization(client, incoming.organization_id);
      const selected = await client.query<StoredAuthority>(
        `SELECT ${authorityColumns} FROM execution_configurations WHERE organization_id = $1 FOR UPDATE`,
        [incoming.organization_id],
      );
      const current = selected.rows[0];
      let identities: Identities = { providers: [], runtimes: [] };
      if ((current === undefined ? null : Number(current.revision)) !== expectedRevision)
        return false;
      if (current !== undefined) {
        if (Number(current.revision) > incoming.revision) return false;
        const equalRevision = Number(current.revision) === incoming.revision;
        const knownProjection = parsePublicExecutionConfiguration(current.configuration);
        if (equalRevision && !isDeepStrictEqual(knownProjection, projection)) throw conflict();
        const authority = this.openAuthority(current);
        if (authority !== null) {
          if (equalRevision) {
            if (!isDeepStrictEqual(authority.configuration, incoming)) throw conflict();
            return true;
          }
          identities = authority.identities;
        } else {
          // Legacy rows have no private proof, but their public connection scope
          // is still immutable when authenticated publication fills the seal.
          identities = {
            providers: knownProjection.providers.map((provider) => ({
              connection_id: provider.connection_id,
              routing: {
                provider_key: provider.provider_key,
                request_protocol: provider.request_protocol,
                base_url: provider.base_url,
              },
              credentials: [],
            })),
            runtimes: knownProjection.agents.flatMap((agent) =>
              agent.runtime?.connection_id === undefined
                ? []
                : [
                    {
                      connection_id: agent.runtime.connection_id,
                      agent_id: agent.agent_id,
                      runtime_revision: agent.runtime.runtime_revision,
                    },
                  ],
            ),
          };
        }
      }
      identities = retainIdentities(identities, incoming);
      requireUniqueIdentities(identities);
      const sealed = this.box.seal(
        { configuration: incoming, identities },
        associatedData(incoming.organization_id, incoming.revision),
      );
      const values = [
        incoming.organization_id,
        incoming.revision,
        JSON.stringify(projection),
        1,
        sealed.nonce,
        sealed.ciphertext,
      ];
      const saved =
        current === undefined
          ? await client.query(
              `INSERT INTO execution_configurations(${authorityColumns})
           VALUES ($1, $2, $3::jsonb, $4, $5, $6) ON CONFLICT (organization_id) DO NOTHING`,
              values,
            )
          : await client.query(
              `UPDATE execution_configurations SET revision = $2, configuration = $3::jsonb,
             authority_version = $4, authority_nonce = $5, authority_ciphertext = $6, updated_at = now()
           WHERE organization_id = $1 AND revision = $7
             AND (revision < $2 OR (revision = $2 AND authority_version IS NULL))`,
              [...values, expectedRevision],
            );
      if (saved.rowCount !== 1) return false;
      await retireReplacedRuntimeBarriers(client, projection);
      return true;
    });
  }
}
