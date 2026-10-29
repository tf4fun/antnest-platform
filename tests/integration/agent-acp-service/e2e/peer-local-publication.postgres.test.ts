import { createHash, randomBytes } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { PostgresAgentLeases } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { buildComponents } from "../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../services/agent-acp-service/src/config.js";
import { PostgresExecutionConfiguration } from "../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { executionPublication } from "../../../../services/agent-acp-service/src/domain/execution-publication.js";
import type { ExecutionConfiguration } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  executionConfiguration,
  runtimeConfiguration,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { runtimeConnections } from "../../../../services/agent-acp-service/test/support/runtime-connections.js";
import { withDatabase, registration } from "../support/run-fencing-fixture.js";

async function withLocal(
  localCount: number,
  action: (
    f: Parameters<Parameters<typeof withDatabase>[0]>[0],
    local: {
      built: ReturnType<typeof buildComponents>;
      repository: PostgresExecutionConfiguration;
      capture: Awaited<
        ReturnType<
          ReturnType<
            typeof buildComponents
          >["directory"]["applyPeerPublication"]
        >
      >;
      box: SecretBox;
    },
  ) => Promise<void>,
) {
  await withDatabase(async (f) => {
    const key = randomBytes(32);
    const box = new SecretBox(key);
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
      ANTNEST_ACP_CLIENT_MCP_KEY: key.toString("base64"),
    });
    const connections = runtimeConnections();
    const lifetime = new AbortController();
    const built = buildComponents(
      f.a,
      config,
      NOOP_TELEMETRY,
      () => {
        throw new Error("Unexpected global failure");
      },
      lifetime.signal,
      connections,
      registration(),
    );
    const failures: unknown[] = [];
    try {
      const configuration = executionConfiguration();
      configuration.agents.push({
        ...structuredClone(configuration.agents[0]!),
        agent_id: "agent-2",
        runtime: runtimeConfiguration(2),
      });
      const foreign = registration("acp-b");
      for (const agent of configuration.agents.slice(localCount))
        await f.owner(
          {
            organizationId: configuration.organization_id,
            agentId: agent.agent_id,
          },
          foreign,
          "b",
        );
      const repository = new PostgresExecutionConfiguration(f.kernelA, box);
      await repository.save(configuration, null);
      const capture = await built.directory.applyPeerPublication(
        executionPublication(configuration),
      );
      await action(f, { built, repository, capture, box });
    } catch (error) {
      failures.push(error);
    } finally {
      lifetime.abort(new Error("Peer local receipt fixture is closing"));
      const results = await Promise.allSettled([
        built.owned!.shutdown(),
        built.supervisor.shutdown(),
        built.joinRevocations(),
      ]);
      for (const result of results)
        if (result.status === "rejected")
          failures.push(result.reason as unknown);
      for (const close of [
        () => connections.close(),
        () => config.authentication.workload.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Peer local fixture failed");
  });
}

describe.skipIf(process.env.ANTNEST_ACP_TEST_DATABASE_URL === undefined)(
  "production peer local publication receipt",
  () => {
    it("joins automatic lease expiry retirement before a zero-owner receipt", async () => {
      // Use a real one-second database lease; keep the production expiry timer.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const acquire = PostgresAgentLeases.prototype.tryAcquire;
      const shortened = vi
        .spyOn(PostgresAgentLeases.prototype, "tryAcquire")
        .mockImplementation(function (
          this: PostgresAgentLeases,
          scope,
          owner,
          duration,
        ) {
          return acquire.call(
            this,
            scope,
            owner,
            scope.agentId === "agent-1" ? 1000 : duration,
          );
        });
      try {
        await withLocal(1, async (f, { built, capture }) => {
          const [fence] = await built.owned!.localPublicationFences(
            capture,
            new AbortController().signal,
          );
          const held = await f.holdLease(fence!);
          let receipt:
            | ReturnType<
                NonNullable<typeof built.owned>["localPublicationFences"]
              >
            | undefined;
          try {
            // The expiry callback, rather than withdraw(), initiates the real
            // release query. Keep that original database cleanup blocked.
            await f.waitForBlockedWriter(f.nameA);
            receipt = built.owned!.localPublicationFences(
              capture,
              new AbortController().signal,
            );
            const outcome = receipt.then(
              () => "receipt",
              () => "failure",
            );
            expect(
              await Promise.race([outcome, delay(100).then(() => "held")]),
            ).toBe("held");
            await f.release(held);
            await expect(receipt).resolves.toEqual([]);
          } finally {
            await f.release(held);
            await Promise.allSettled([receipt]);
          }
        });
      } finally {
        shortened.mockRestore();
      }
    });

    it.each([0, 1])(
      "reports only %i locally owned Agents while the remaining Agent leases belong to another owner",
      async (localCount) => {
        await withLocal(localCount, async (_f, { built, capture }) => {
          const fences = await built.owned!.localPublicationFences(
            capture,
            new AbortController().signal,
          );
          expect(fences.map((fence) => fence.agentId)).toEqual(
            localCount === 0 ? [] : ["agent-1"],
          );
          expect(Object.isFrozen(fences)).toBe(true);
          for (const fence of fences) expect(Object.isFrozen(fence)).toBe(true);
        });
      },
    );

    it("validates private authority even when this member owns no Agent", async () => {
      await withLocal(0, async (f, { built, repository, capture, box }) => {
        const org = capture.authority.organization_id;
        const row = (
          await f.observer.query<{
            authority_nonce: Buffer;
            authority_ciphertext: Buffer;
          }>(
            "SELECT authority_nonce,authority_ciphertext FROM execution_configurations WHERE organization_id=$1",
            [org],
          )
        ).rows[0]!;
        const aad = JSON.stringify([
          "agent-acp-service/execution-authority",
          1,
          org,
          capture.authority.revision,
        ]);
        const envelope = box.open<{
          configuration: ExecutionConfiguration;
          identities: {
            providers: {
              credentials: { revision: string; digest: string }[];
            }[];
          };
        }>(
          { nonce: row.authority_nonce, ciphertext: row.authority_ciphertext },
          aad,
        );
        const provider = envelope.configuration.providers[0]!;
        if (!("credential" in provider) || !("secret" in provider.credential))
          throw new Error("Expected provider credential");
        provider.credential.secret += "-changed";
        envelope.identities.providers[0]!.credentials.find(
          (credential) => credential.revision === provider.credential_revision,
        )!.digest = createHash("sha256")
          .update(provider.credential.secret)
          .digest("hex");
        const sealed = box.seal(envelope, aad);
        await f.observer.query(
          "UPDATE execution_configurations SET authority_nonce=$2,authority_ciphertext=$3 WHERE organization_id=$1",
          [org, sealed.nonce, sealed.ciphertext],
        );
        expect(await repository.loadAuthority(org)).toEqual(
          envelope.configuration,
        );
        await expect(
          built.owned!.localPublicationFences(
            capture,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: "configuration_unavailable" });
      });
    });

    it("rejects a generation retired while its original owned authority query waits", async () => {
      await withLocal(1, async (f, { built, capture }) => {
        const [fence] = await built.owned!.localPublicationFences(
          capture,
          new AbortController().signal,
        );
        const held = await f.holdLease(fence!);
        const receipt = built.owned!.localPublicationFences(
          capture,
          new AbortController().signal,
        );
        void receipt.catch(() => undefined);
        try {
          await f.waitForBlockedWriter(f.nameA);
          built.owned!.withdraw(capture.authority.organization_id);
          await f.release(held);
          await expect(receipt).rejects.toThrow();
        } finally {
          await f.release(held);
          await Promise.allSettled([receipt]);
        }
      });
    });

    it("joins the original retiring generation before returning a zero-owner receipt", async () => {
      await withLocal(1, async (f, { built, capture }) => {
        const [fence] = await built.owned!.localPublicationFences(
          capture,
          new AbortController().signal,
        );
        const held = await f.holdLease(fence!);
        let receipt:
          | ReturnType<
              NonNullable<typeof built.owned>["localPublicationFences"]
            >
          | undefined;
        try {
          built.owned!.withdraw(capture.authority.organization_id);
          await f.waitForBlockedWriter(f.nameA);
          let settled = false;
          receipt = built.owned!.localPublicationFences(
            capture,
            new AbortController().signal,
          );
          void receipt.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await nextTurn();
          expect(settled).toBe(false);
          await f.release(held);
          await expect(receipt).resolves.toEqual([]);
        } finally {
          await f.release(held);
          await Promise.allSettled([receipt]);
        }
      });
    });
  },
);
