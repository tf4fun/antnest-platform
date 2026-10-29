import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  type ExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const invalidAuthority = "Stored execution authority is invalid";
const organizations: string[] = [];

// This local shape keeps the red tests compilable before the production port
// grows its authority methods. Every call still uses the real PG adapter.
type AuthorityRepository = {
  load(organizationId: string): Promise<PublicExecutionConfiguration | null>;
  loadAuthority(organizationId: string): Promise<ExecutionConfiguration | null>;
  listOrganizations(): Promise<string[]>;
  save(
    configuration: ExecutionConfiguration,
    expectedRevision: number | null,
  ): Promise<boolean>;
};
const AuthorityRepositoryConstructor =
  PostgresExecutionConfiguration as unknown as new (
    kernel: PostgresKernel,
    box: SecretBox,
  ) => AuthorityRepository;

type StoredAuthority = {
  organization_id: string;
  revision: string;
  configuration: unknown;
  authority_version: number | null;
  authority_nonce: Buffer | null;
  authority_ciphertext: Buffer | null;
};

describe.skipIf(databaseUrl === undefined)(
  "sealed execution authority storage",
  () => {
    const pool = createPool();
    const key = randomBytes(32);
    const box = new SecretBox(key);
    const repository = new AuthorityRepositoryConstructor(
      new PostgresKernel(pool),
      box,
    );

    beforeAll(async () => {
      expect(new URL(databaseUrl!).pathname).toMatch(/_test$/u);
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      await pool.query(`
      CREATE TABLE execution_authority_test_faults (organization_id text PRIMARY KEY);
      CREATE FUNCTION reject_execution_authority_test_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM execution_authority_test_faults
          WHERE organization_id = NEW.organization_id
        ) THEN
          RAISE EXCEPTION 'controlled execution authority write failure'
            USING ERRCODE = 'P0050';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_execution_authority_test_write
        BEFORE INSERT OR UPDATE ON execution_configurations
        FOR EACH ROW EXECUTE FUNCTION reject_execution_authority_test_write();
    `);
    });

    afterEach(async () => {
      await pool.query("DELETE FROM execution_authority_test_faults");
    });

    afterAll(async () => {
      try {
        await pool.query(
          "DELETE FROM execution_configurations WHERE organization_id = ANY($1::text[])",
          [organizations],
        );
        await pool.query(`
        DROP TRIGGER IF EXISTS reject_execution_authority_test_write ON execution_configurations;
        DROP FUNCTION IF EXISTS reject_execution_authority_test_write();
        DROP TABLE IF EXISTS execution_authority_test_faults;
      `);
      } finally {
        await pool.end();
      }
    });

    async function raw(
      organizationId: string,
    ): Promise<StoredAuthority | null> {
      const result = await pool.query<StoredAuthority>(
        `SELECT organization_id, revision, configuration,
              authority_version, authority_nonce, authority_ciphertext
       FROM execution_configurations WHERE organization_id = $1`,
        [organizationId],
      );
      expect(result.rows.length).toBeLessThanOrEqual(1);
      return result.rows[0] ?? null;
    }

    async function insertLegacy(
      configuration: ExecutionConfiguration,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO execution_configurations(organization_id, revision, configuration)
       VALUES ($1, $2, $3::jsonb)`,
        [
          configuration.organization_id,
          configuration.revision,
          JSON.stringify(publicExecutionConfiguration(configuration)),
        ],
      );
    }

    function restarted(
      storage = pool,
      encryptionKey = key,
    ): AuthorityRepository {
      return new AuthorityRepositoryConstructor(
        new PostgresKernel(storage),
        new SecretBox(encryptionKey),
      );
    }

    it("round-trips complete authority under the purpose-bound seal while load remains public", async () => {
      const input = configuration();
      expect(await repository.load(input.organization_id)).toBeNull();
      expect(await repository.loadAuthority(input.organization_id)).toBeNull();
      expect(await repository.save(input, null)).toBe(true);
      expect(await restarted().loadAuthority(input.organization_id)).toEqual(
        input,
      );
      const projection = publicExecutionConfiguration(input);
      expect(await repository.load(input.organization_id)).toEqual(projection);
      const row = await raw(input.organization_id);
      expect(row).not.toBeNull();
      expect(row!.configuration).toEqual(projection);
      expect(row!.authority_version).toBe(1);
      expect(row!.authority_nonce).toHaveLength(12);
      expect(row!.authority_ciphertext!.byteLength).toBeGreaterThanOrEqual(16);
      expect(
        box.open<{ configuration: unknown }>(
          {
            nonce: row!.authority_nonce!,
            ciphertext: row!.authority_ciphertext!,
          },
          associatedData(input),
        ).configuration,
      ).toEqual(input);
      for (const secret of [
        provider(input).credential.secret,
        runtime(input).credential!.token,
      ]) {
        expect(JSON.stringify(projection)).not.toContain(secret);
        expect(row!.authority_ciphertext!.includes(Buffer.from(secret))).toBe(
          false,
        );
      }
      expect(row!.authority_ciphertext!.includes(key)).toBe(false);
    });

    it("uses fresh nonces for new committed revisions and other organizations", async () => {
      const first = configuration();
      const other = configuration();
      expect(await repository.save(first, null)).toBe(true);
      expect(await repository.save(other, null)).toBe(true);
      const initial = await raw(first.organization_id);
      const independent = await raw(other.organization_id);
      const next = structuredClone(first);
      next.revision = 2;
      next.agents[0]!.system_prompt += " Updated.";
      expect(await repository.save(next, 1)).toBe(true);
      const updated = await raw(first.organization_id);
      expect(
        new Set([
          initial!.authority_nonce!.toString("hex"),
          independent!.authority_nonce!.toString("hex"),
          updated!.authority_nonce!.toString("hex"),
        ]).size,
      ).toBe(3);
      expect(updated!.authority_ciphertext).not.toEqual(
        initial!.authority_ciphertext,
      );
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        next,
      );
    });

    it("accepts an identical equal revision without rewriting any seal bytes", async () => {
      const input = configuration();
      expect(await repository.save(input, null)).toBe(true);
      const before = await raw(input.organization_id);
      expect(
        await restarted().save(structuredClone(input), input.revision),
      ).toBe(true);
      expect(await raw(input.organization_id)).toEqual(before);
      expect(await repository.loadAuthority(input.organization_id)).toEqual(
        input,
      );
    });

    it("keeps public and private state unchanged when the expected revision does not match", async () => {
      const first = configuration();
      expect(await repository.save(first, 1)).toBe(false);
      expect(await raw(first.organization_id)).toBeNull();
      expect(await repository.save(first, null)).toBe(true);
      const next = structuredClone(first);
      next.revision = 2;
      next.agents[0]!.principal_ids = [];
      const before = await raw(first.organization_id);
      expect(await repository.save(next, null)).toBe(false);
      expect(await repository.save(next, 2)).toBe(false);
      expect(await raw(first.organization_id)).toEqual(before);
      expect(await repository.save(next, 1)).toBe(true);
      const committed = await raw(first.organization_id);
      expect(await repository.save({ ...next, revision: 3 }, 1)).toBe(false);
      expect(await repository.save(next, 1)).toBe(false);
      expect(await raw(first.organization_id)).toEqual(committed);
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        next,
      );
    });

    it.each([
      ["Provider", 1],
      ["Provider", 2],
      ["Runtime", 1],
      ["Runtime", 2],
    ] as const)(
      "rejects %s secret replacement at configuration revision %s even in a fresh repository",
      async (kind, revision) => {
        const input = configuration();
        expect(await repository.save(input, null)).toBe(true);
        const before = await raw(input.organization_id);
        const changed = structuredClone(input);
        changed.revision = revision;
        if (kind === "Provider")
          provider(changed).credential.secret =
            randomBytes(32).toString("base64url");
        else
          runtime(changed).credential!.token =
            randomBytes(32).toString("base64url");
        await expect(restarted().save(changed, 1)).rejects.toMatchObject({
          code: "configuration_conflict",
        });
        expect(await raw(input.organization_id)).toEqual(before);
        expect(await repository.loadAuthority(input.organization_id)).toEqual(
          input,
        );
      },
    );

    it("permits explicit new Provider and Runtime credential identities at a newer revision", async () => {
      const first = configuration();
      expect(await repository.save(first, null)).toBe(true);
      const next = structuredClone(first);
      next.revision = 2;
      provider(next).credential_revision = "credential-2";
      provider(next).credential.secret = randomBytes(32).toString("base64url");
      runtime(next).connection_id = "rci_" + randomBytes(16).toString("hex");
      runtime(next).runtime_revision = "rtv_" + randomBytes(16).toString("hex");
      runtime(next).runtime_execution_id = "execution-2";
      runtime(next).credential!.token = randomBytes(32).toString("base64url");
      expect(await restarted().save(parseExecutionConfiguration(next), 1)).toBe(
        true,
      );
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        next,
      );
      expect(await repository.load(first.organization_id)).toEqual(
        publicExecutionConfiguration(next),
      );
    });

    it("retains Provider credential identity through a disabled revision without credentials", async () => {
      const first = configuration();
      expect(await repository.save(first, null)).toBe(true);
      const disabled = structuredClone(first);
      disabled.revision = 2;
      const previous = provider(first);
      disabled.providers[0] = {
        connection_id: previous.connection_id,
        provider_key: previous.provider_key,
        request_protocol: previous.request_protocol,
        base_url: previous.base_url,
        enabled: false,
      };
      const current = parseExecutionConfiguration(disabled);
      expect(await restarted().save(current, 1)).toBe(true);
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        current,
      );
      const before = await raw(first.organization_id);
      const reopened = structuredClone(first);
      reopened.revision = 3;
      provider(reopened).credential.secret =
        randomBytes(32).toString("base64url");
      await expect(restarted().save(reopened, 2)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(await raw(first.organization_id)).toEqual(before);
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        current,
      );
    });

    it("retains Runtime credential identity through a closed revision across repository recreation", async () => {
      const first = configuration();
      expect(await repository.save(first, null)).toBe(true);
      const closed = structuredClone(first);
      closed.revision = 2;
      closed.agents[0]!.accepting_runs = false;
      closed.agents[0]!.unavailable_reason = "rebuilding";
      closed.agents[0]!.operation_id = "operation-authority-aba";
      delete runtime(closed).credential;
      const current = parseExecutionConfiguration(closed);
      expect(await restarted().save(current, 1)).toBe(true);
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        current,
      );
      const before = await raw(first.organization_id);
      const reopened = structuredClone(first);
      reopened.revision = 3;
      runtime(reopened).credential!.token =
        randomBytes(32).toString("base64url");
      await expect(restarted().save(reopened, 2)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(await raw(first.organization_id)).toEqual(before);
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        current,
      );
    });

    it("permits a Runtime process restart with the same generation credential and a new execution fence and endpoint", async () => {
      const first = configuration();
      expect(await repository.save(first, null)).toBe(true);
      const next = structuredClone(first);
      next.revision = 2;
      runtime(next).runtime_execution_id = "execution-after-process-restart";
      runtime(next).mcp_endpoint =
        "http://runtime-after-process-restart:8080/mcp";
      const current = parseExecutionConfiguration(next);
      expect(await restarted().save(current, 1)).toBe(true);
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        current,
      );
      expect(await repository.load(first.organization_id)).toEqual(
        publicExecutionConfiguration(current),
      );
      expect(runtime(current).connection_id).toBe(runtime(first).connection_id);
      expect(runtime(current).runtime_revision).toBe(
        runtime(first).runtime_revision,
      );
      expect(
        runtime(current).credential!.token === runtime(first).credential!.token,
      ).toBe(true);
    });

    it("keeps a legacy public-only row closed until an identical projection is filled", async () => {
      const input = configuration();
      await insertLegacy(input);
      const legacy = await raw(input.organization_id);
      expect(legacy).toMatchObject({
        authority_version: null,
        authority_nonce: null,
        authority_ciphertext: null,
      });
      expect(await repository.load(input.organization_id)).toEqual(
        publicExecutionConfiguration(input),
      );
      expect(await repository.loadAuthority(input.organization_id)).toBeNull();
      expect(await repository.save(input, input.revision)).toBe(true);
      expect(await restarted().loadAuthority(input.organization_id)).toEqual(
        input,
      );
      const filled = await raw(input.organization_id);
      expect(filled!.authority_version).toBe(1);
      expect(filled!.configuration).toEqual(legacy!.configuration);
      expect(filled!.revision).toBe(legacy!.revision);
      expect(await restarted().save(input, input.revision)).toBe(true);
      expect(await raw(input.organization_id)).toEqual(filled);
    });

    it("does not backfill a legacy row with a different public projection", async () => {
      const input = configuration();
      await insertLegacy(input);
      const before = await raw(input.organization_id);
      const changed = structuredClone(input);
      changed.agents[0]!.principal_ids = [];
      await expect(repository.save(changed, 1)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(await raw(input.organization_id)).toEqual(before);
      expect(await repository.loadAuthority(input.organization_id)).toBeNull();
    });

    it("allows only one private identity when two repositories concurrently fill the same legacy row", async () => {
      const first = configuration();
      const second = structuredClone(first);
      provider(second).credential.secret =
        randomBytes(32).toString("base64url");
      await insertLegacy(first);
      const names = [
        "authority_a_" + randomBytes(8).toString("hex"),
        "authority_b_" + randomBytes(8).toString("hex"),
      ];
      const pools = names.map((name) => createPool(name));
      const repositories = pools.map((storage) => restarted(storage));
      const start = Promise.withResolvers<void>();
      const pending: Promise<boolean>[] = [];
      const finished = [false, false];
      let gate: PoolClient | undefined;
      let held = false;
      const failures: unknown[] = [];
      try {
        gate = await pool.connect();
        await gate.query("BEGIN");
        held = true;
        await gate.query(
          "SELECT organization_id FROM execution_configurations WHERE organization_id = $1 FOR UPDATE",
          [first.organization_id],
        );
        for (const [index, input] of [first, second].entries()) {
          const writing = start.promise.then(() =>
            repositories[index]!.save(input, 1),
          );
          pending.push(writing);
          void writing.then(
            () => {
              finished[index] = true;
            },
            () => {
              finished[index] = true;
            },
          );
        }
        start.resolve();
        await expect
          .poll(
            async () => {
              if (finished.some(Boolean))
                throw new Error(
                  "Legacy fill finished before the held row was released",
                );
              const waiting = await pool.query<{ application_name: string }>(
                `SELECT application_name FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = ANY($1::text[])
             AND wait_event_type = 'Lock'`,
                [names],
              );
              return new Set(waiting.rows.map((row) => row.application_name))
                .size;
            },
            { timeout: 3000 },
          )
          .toBe(2);
        await gate.query("ROLLBACK");
        held = false;
        const results = await Promise.allSettled(pending);
        const winners = results.flatMap((result, index) =>
          result.status === "fulfilled" && result.value ? [index] : [],
        );
        expect(winners).toHaveLength(1);
        const winner = winners[0]!;
        const loser = results[1 - winner]!;
        if (loser.status === "fulfilled") expect(loser.value).toBe(false);
        else
          expect(loser.reason).toMatchObject({
            code: "configuration_conflict",
          });
        const inputs = [first, second];
        expect(await repository.loadAuthority(first.organization_id)).toEqual(
          inputs[winner],
        );
        const committed = await raw(first.organization_id);
        await expect(
          restarted().save(inputs[1 - winner]!, 1),
        ).rejects.toMatchObject({ code: "configuration_conflict" });
        expect(await raw(first.organization_id)).toEqual(committed);
      } catch (error) {
        failures.push(error);
      } finally {
        start.resolve();
        if (gate !== undefined) {
          if (held) {
            try {
              await gate.query("ROLLBACK");
            } catch (error) {
              failures.push(error);
            }
          }
          gate.release(held);
        }
        await Promise.allSettled(pending);
        const closed = await Promise.allSettled(
          pools.map((storage) => storage.end()),
        );
        for (const result of closed)
          if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Legacy fill or cleanup failed");
    });

    it("fails closed with a safe message when reopened using another bootstrap key", async () => {
      const input = configuration();
      expect(await repository.save(input, null)).toBe(true);
      const before = await raw(input.organization_id);
      const wrongKey = restarted(pool, randomBytes(32));
      expect(await wrongKey.load(input.organization_id)).toEqual(
        publicExecutionConfiguration(input),
      );
      await expect(
        wrongKey.loadAuthority(input.organization_id),
      ).rejects.toMatchObject({ message: invalidAuthority });
      expect(await raw(input.organization_id)).toEqual(before);
      expect(await repository.loadAuthority(input.organization_id)).toEqual(
        input,
      );
    });

    it.each(["ciphertext", "organization", "revision", "projection"] as const)(
      "rejects %s tampering without affecting another healthy organization",
      async (kind) => {
        const bad = configuration();
        const healthy = configuration();
        expect(await repository.save(bad, null)).toBe(true);
        expect(await repository.save(healthy, null)).toBe(true);
        const healthyBefore = await raw(healthy.organization_id);
        const row = await raw(bad.organization_id);
        if (kind === "ciphertext") {
          const changed = Buffer.from(row!.authority_ciphertext!);
          changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
          await pool.query(
            "UPDATE execution_configurations SET authority_ciphertext = $2 WHERE organization_id = $1",
            [bad.organization_id, changed],
          );
        } else if (kind === "organization") {
          await pool.query(
            `UPDATE execution_configurations SET authority_version = $2,
                  authority_nonce = $3, authority_ciphertext = $4 WHERE organization_id = $1`,
            [
              bad.organization_id,
              healthyBefore!.authority_version,
              healthyBefore!.authority_nonce,
              healthyBefore!.authority_ciphertext,
            ],
          );
        } else if (kind === "revision") {
          const projection = publicExecutionConfiguration(bad);
          projection.revision = 2;
          await pool.query(
            "UPDATE execution_configurations SET revision = 2, configuration = $2::jsonb WHERE organization_id = $1",
            [bad.organization_id, JSON.stringify(projection)],
          );
        } else {
          const projection = publicExecutionConfiguration(bad);
          projection.agents[0]!.system_prompt += " Tampered public projection.";
          await pool.query(
            "UPDATE execution_configurations SET configuration = $2::jsonb WHERE organization_id = $1",
            [bad.organization_id, JSON.stringify(projection)],
          );
        }
        const tampered = await raw(bad.organization_id);
        await expect(
          restarted().loadAuthority(bad.organization_id),
        ).rejects.toMatchObject({ message: invalidAuthority });
        expect(await raw(bad.organization_id)).toEqual(tampered);
        expect(
          await restarted().loadAuthority(healthy.organization_id),
        ).toEqual(healthy);
        expect(await repository.load(healthy.organization_id)).toEqual(
          publicExecutionConfiguration(healthy),
        );
        expect(await raw(healthy.organization_id)).toEqual(healthyBefore);
        const organizations = await repository.listOrganizations();
        expect(organizations).toEqual(
          expect.arrayContaining([
            bad.organization_id,
            healthy.organization_id,
          ]),
        );
        expect(new Set(organizations).size).toBe(organizations.length);
      },
    );

    it.each(["Provider", "Runtime", "malformed"] as const)(
      "validates decrypted %s authority instead of trusting authenticated JSON alone",
      async (kind) => {
        const input = configuration();
        expect(await repository.save(input, null)).toBe(true);
        const row = await raw(input.organization_id);
        const envelope = box.open<{
          configuration: ExecutionConfiguration;
          identities: unknown;
        }>(
          {
            nonce: row!.authority_nonce!,
            ciphertext: row!.authority_ciphertext!,
          },
          associatedData(input),
        );
        const privateValue = envelope.configuration;
        if (kind === "Provider")
          Reflect.deleteProperty(provider(privateValue), "credential");
        else if (kind === "Runtime") delete runtime(privateValue).credential;
        const sealed = box.seal(
          kind === "malformed"
            ? { secret: provider(input).credential.secret }
            : envelope,
          associatedData(input),
        );
        await pool.query(
          "UPDATE execution_configurations SET authority_nonce = $2, authority_ciphertext = $3 WHERE organization_id = $1",
          [input.organization_id, sealed.nonce, sealed.ciphertext],
        );
        await expect(
          repository.loadAuthority(input.organization_id),
        ).rejects.toMatchObject({ message: invalidAuthority });
      },
    );

    it.each(["insert", "replace"] as const)(
      "rolls back the entire %s when PostgreSQL rejects the authority write",
      async (kind) => {
        const first = configuration();
        if (kind === "replace")
          expect(await repository.save(first, null)).toBe(true);
        const before = await raw(first.organization_id);
        const incoming = structuredClone(first);
        if (kind === "replace") {
          incoming.revision = 2;
          incoming.agents[0]!.principal_ids = [];
          provider(incoming).credential_revision = "credential-2";
          provider(incoming).credential.secret =
            randomBytes(32).toString("base64url");
        }
        await pool.query(
          "INSERT INTO execution_authority_test_faults(organization_id) VALUES ($1)",
          [first.organization_id],
        );
        await expect(
          repository.save(incoming, kind === "insert" ? null : 1),
        ).rejects.toMatchObject({
          code: "P0050",
          message: "controlled execution authority write failure",
        });
        expect(await raw(first.organization_id)).toEqual(before);
        expect(await repository.load(first.organization_id)).toEqual(
          kind === "insert" ? null : publicExecutionConfiguration(first),
        );
        expect(await repository.loadAuthority(first.organization_id)).toEqual(
          kind === "insert" ? null : first,
        );
      },
    );

    it("propagates a real PostgreSQL dependency failure from both authority read and enumeration", async () => {
      const missing = new URL(databaseUrl!);
      missing.pathname =
        "/authority_missing_" + randomBytes(12).toString("hex");
      const unavailable = new Pool({
        connectionString: missing.href,
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 5000,
      });
      try {
        const failed = restarted(unavailable);
        await expect(failed.loadAuthority(randomUUID())).rejects.toMatchObject({
          code: "3D000",
        });
        await expect(failed.listOrganizations()).rejects.toMatchObject({
          code: "3D000",
        });
      } finally {
        await unavailable.end();
      }
    });

    it("rejects changed Provider routing at a newer revision of a legacy public-only row", async () => {
      const first = configuration();
      await insertLegacy(first);
      const before = await repository.load(first.organization_id);
      expect(before).toEqual(publicExecutionConfiguration(first));
      const next = structuredClone(first);
      next.revision = 2;
      provider(next).base_url = "https://provider-routing-changed.example/v1";
      await expect(restarted().save(next, 1)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(await repository.load(first.organization_id)).toEqual(before);
      expect(await restarted().loadAuthority(first.organization_id)).toBeNull();
    });

    it("stores a first disabled Provider and closed Runtime without inventing credential identities", async () => {
      const first = configuration();
      const previous = provider(first);
      first.providers[0] = {
        connection_id: previous.connection_id,
        provider_key: previous.provider_key,
        request_protocol: previous.request_protocol,
        base_url: previous.base_url,
        enabled: false,
      };
      first.agents[0]!.accepting_runs = false;
      first.agents[0]!.unavailable_reason = "rebuilding";
      first.agents[0]!.operation_id = "operation-first-closed-authority";
      delete runtime(first).credential;
      const current = parseExecutionConfiguration(first);
      expect(await repository.save(current, null)).toBe(true);
      expect(await restarted().loadAuthority(first.organization_id)).toEqual(
        current,
      );
      expect(await repository.load(first.organization_id)).toEqual(
        publicExecutionConfiguration(current),
      );
    });

    it.each(["Provider", "Runtime"] as const)(
      "retains %s credential identity through an empty configuration across repository recreation",
      async (kind) => {
        const first = configuration();
        expect(await repository.save(first, null)).toBe(true);
        const empty = parseExecutionConfiguration({
          organization_id: first.organization_id,
          revision: 2,
          providers: [],
          models: [],
          agents: [],
        });
        expect(await restarted().save(empty, 1)).toBe(true);
        expect(await restarted().loadAuthority(first.organization_id)).toEqual(
          empty,
        );
        const reopened = structuredClone(first);
        reopened.revision = 3;
        if (kind === "Provider")
          provider(reopened).credential.secret =
            randomBytes(32).toString("base64url");
        else
          runtime(reopened).credential!.token =
            randomBytes(32).toString("base64url");
        await expect(restarted().save(reopened, 2)).rejects.toMatchObject({
          code: "configuration_conflict",
        });
        expect(await repository.load(first.organization_id)).toEqual(
          publicExecutionConfiguration(empty),
        );
        expect(await restarted().loadAuthority(first.organization_id)).toEqual(
          empty,
        );
      },
    );

    it("rejects duplicate Runtime identities from legacy scope before sealing an empty newer configuration", async () => {
      const legacy = configuration();
      const other = structuredClone(legacy.agents[0]!);
      other.agent_id = "agent-legacy-duplicate-runtime";
      legacy.agents.push(other);
      await insertLegacy(legacy);
      const before = await raw(legacy.organization_id);
      const publicBefore = await repository.load(legacy.organization_id);
      expect(publicBefore).toEqual(publicExecutionConfiguration(legacy));
      const empty = parseExecutionConfiguration({
        organization_id: legacy.organization_id,
        revision: 2,
        providers: [],
        models: [],
        agents: [],
      });
      await expect(restarted().save(empty, 1)).rejects.toMatchObject({
        name: "InvalidExecutionAuthorityError",
        message: invalidAuthority,
      });
      expect(await raw(legacy.organization_id)).toEqual(before);
      expect(await repository.load(legacy.organization_id)).toEqual(
        publicBefore,
      );
      expect(
        await restarted().loadAuthority(legacy.organization_id),
      ).toBeNull();
    });
  },
);

function createPool(applicationName?: string): Pool {
  const url = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  if (applicationName !== undefined)
    url?.searchParams.set("application_name", applicationName);
  return new Pool({
    ...(url === undefined ? {} : { connectionString: url.href }),
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
}

function configuration(): ExecutionConfiguration {
  const input = executionConfiguration();
  input.organization_id = randomUUID();
  organizations.push(input.organization_id);
  input.providers[0]!.credential.secret = randomBytes(32).toString("base64url");
  const binding = input.agents[0]!.runtime!;
  binding.connection_id = "rci_" + randomBytes(16).toString("hex");
  binding.runtime_revision = "rtv_" + randomBytes(16).toString("hex");
  binding.credential!.token = randomBytes(32).toString("base64url");
  return parseExecutionConfiguration(input);
}

function provider(input: ExecutionConfiguration) {
  const value = input.providers[0];
  const credential = value !== undefined && "credential" in value ? value.credential : undefined;
  if (
    value === undefined ||
    credential === undefined ||
    !("secret" in credential) ||
    !("credential_revision" in value)
  )
    throw new Error("Fixture Provider authority is missing");
  return { ...value, credential };
}

function runtime(input: ExecutionConfiguration) {
  const value = input.agents[0]?.runtime;
  if (value === undefined || value === null)
    throw new Error("Fixture Runtime binding is missing");
  return value;
}

function associatedData(input: ExecutionConfiguration): string {
  return JSON.stringify([
    "agent-acp-service/execution-authority",
    1,
    input.organization_id,
    input.revision,
  ]);
}
