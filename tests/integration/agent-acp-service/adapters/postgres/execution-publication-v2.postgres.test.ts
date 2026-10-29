import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import {
  parseExecutionAuthority,
  type ExecutionConfigurationV2,
} from "../../../../../services/agent-acp-service/src/domain/execution-publication-v2.js";
import type { ExecutionConfigurationV1 } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "execution publication v2 private storage",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const box = new SecretBox(randomBytes(32));
    const repository = new PostgresExecutionConfiguration(
      new PostgresKernel(pool),
      box,
    );
    const organizations: string[] = [];

    function v1(): ExecutionConfigurationV1 {
      const input = executionConfiguration();
      input.organization_id = randomUUID();
      organizations.push(input.organization_id);
      return parseExecutionConfiguration(input);
    }

    function v2(legacy: ExecutionConfigurationV1): ExecutionConfigurationV2 {
      const candidates = legacy.providers.map((provider) => {
        if (!("credential_revision" in provider))
          throw new Error("fixture requires an enabled Provider");
        return {
          connection_id: provider.connection_id,
          provider_key: provider.provider_key,
          request_protocol: provider.request_protocol,
          base_url: provider.base_url,
          enabled: provider.enabled,
          credential_revision: provider.credential_revision,
          credential: {
            ref: provider.connection_id,
            version: provider.credential_revision,
          },
        };
      });
      return parseExecutionAuthority({
        ...structuredClone(legacy),
        schema_version: 2,
        providers: candidates,
      }) as ExecutionConfigurationV2;
    }

    beforeAll(async () => {
      await migrate(pool);
    });
    afterAll(async () => {
      try {
        await pool.query(
          "DELETE FROM execution_configurations WHERE organization_id = ANY($1::text[])",
          [organizations],
        );
      } finally {
        await pool.end();
      }
    });

    it("persists an equal-revision sealed v1 to v2 upgrade and survives restart", async () => {
      const legacy = v1();
      const incoming = v2(legacy);
      expect(await repository.save(legacy, null)).toBe(true);
      expect(await repository.save(incoming, 1)).toBe(true);
      const restored = await repository.loadAuthority(legacy.organization_id);
      expect(restored).toEqual(incoming);
      const fresh = new PostgresExecutionConfiguration(
        new PostgresKernel(pool),
        box,
      );
      expect(await fresh.loadAuthority(legacy.organization_id)).toEqual(
        incoming,
      );
      const rows = await pool.query<{
        configuration: unknown;
        authority_nonce: Buffer;
        authority_ciphertext: Buffer;
      }>(
        "SELECT configuration, authority_nonce, authority_ciphertext FROM execution_configurations WHERE organization_id = $1",
        [legacy.organization_id],
      );
      const row = rows.rows[0]!;
      expect(row.configuration).toEqual(publicExecutionConfiguration(incoming));
      expect(JSON.stringify(row.configuration)).not.toContain("schema_version");
      expect(JSON.stringify(row.configuration)).not.toContain(
        "synthetic-provider-key",
      );
      const envelope = box.open<{ configuration: ExecutionConfigurationV2 }>(
        { nonce: row.authority_nonce, ciphertext: row.authority_ciphertext },
        JSON.stringify([
          "agent-acp-service/execution-authority",
          1,
          legacy.organization_id,
          incoming.revision,
        ]),
      );
      expect(envelope.configuration).toEqual(incoming);
      const sealedProvider = envelope.configuration.providers[0]!;
      if (!("credential" in sealedProvider))
        throw new Error("v2 fixture requires a credential reference");
      expect("secret" in sealedProvider.credential).toBe(false);
      expect(sealedProvider.credential).toEqual({
        ref: sealedProvider.connection_id,
        version: "credential-1",
      });
    });

    it("denies an equal-revision upgrade with a changed Runtime token or credential version", async () => {
      const legacy = v1();
      const incoming = v2(legacy);
      expect(await repository.save(legacy, null)).toBe(true);
      const token = structuredClone(incoming);
      if (
        token.agents[0]!.runtime === null ||
        token.agents[0]!.runtime.credential === undefined
      )
        throw new Error("fixture requires Runtime credential");
      token.agents[0]!.runtime.credential.token = Buffer.alloc(32, 9).toString(
        "base64url",
      );
      await expect(repository.save(token, 1)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(await repository.loadAuthority(legacy.organization_id)).toEqual(
        legacy,
      );
      const rotated = structuredClone(incoming);
      const rotatedProvider = rotated.providers[0]!;
      if (
        !("credential_revision" in rotatedProvider) ||
        !("credential" in rotatedProvider)
      )
        throw new Error("fixture requires an enabled Provider");
      rotatedProvider.credential_revision = "credential-rotated";
      rotatedProvider.credential.version = "credential-rotated";
      await expect(repository.save(rotated, 1)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(await repository.loadAuthority(legacy.organization_id)).toEqual(
        legacy,
      );
      const upgraded = v2(legacy);
      expect(await repository.save(upgraded, 1)).toBe(true);
      expect(await repository.loadAuthority(legacy.organization_id)).toEqual(
        upgraded,
      );
      const downgraded = parseExecutionConfiguration(executionConfiguration());
      downgraded.organization_id = legacy.organization_id;
      organizations.push(downgraded.organization_id);
      await expect(repository.save(downgraded, 1)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(await repository.loadAuthority(legacy.organization_id)).toEqual(
        upgraded,
      );
    });

    it("keeps ordinary higher-revision v1 publication unchanged", async () => {
      const legacy = v1();
      expect(await repository.save(legacy, null)).toBe(true);
      const next = parseExecutionConfiguration(executionConfiguration());
      next.organization_id = legacy.organization_id;
      next.revision = 2;
      expect(await repository.save(next, 1)).toBe(true);
      expect(await repository.loadAuthority(legacy.organization_id)).toEqual(
        next,
      );
    });
  },
);
