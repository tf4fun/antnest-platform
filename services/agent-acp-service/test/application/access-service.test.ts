import { describe, expect, it } from "vitest";
import { AccessService } from "../../src/application/access-service.js";
import { binding } from "../support/fixtures.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { localExecution } from "../support/local-execution.js";

describe("local Agent access", () => {
  it("requires a current-process configuration, not a stored connection permission", async () => {
    const { directory } = await localExecution(false);
    const service = new AccessService({ directory });
    await expect(service.assert(binding())).rejects.toMatchObject({
      code: "configuration_not_ready",
    });
    await directory.apply(executionConfiguration());
    await expect(service.assert(binding())).resolves.toBeUndefined();
  });

  it("permits authorized resource access while execution is disabled", async () => {
    const { directory } = await localExecution();
    const next = executionConfiguration();
    next.revision = 2;
    next.agents[0]!.accepting_runs = false;
    next.agents[0]!.unavailable_reason = "Rebuilding";
    await directory.apply(next);
    await expect(new AccessService({ directory }).assert(binding())).resolves.toBeUndefined();
  });

  it("uses new permissions on an existing connection without a reconnect handshake", async () => {
    const { directory } = await localExecution();
    const service = new AccessService({ directory });
    const next = executionConfiguration();
    next.revision = 2;
    next.agents[0]!.access_revision = "access-2";
    await directory.apply(next);
    await expect(service.assert(binding())).resolves.toBeUndefined();
    next.revision = 3;
    next.agents[0]!.principal_ids = [];
    await directory.apply(next);
    await expect(service.assert(binding())).rejects.toMatchObject({ code: "access_denied" });
  });

  it.each([
    { principalId: "other-principal" },
    { agentId: "other-agent" },
    { organizationId: "other-organization" },
  ])("does not cross the identity boundary %j", async (changed) => {
    const { directory } = await localExecution();
    const service = new AccessService({ directory });
    await expect(service.assert({ ...binding(), ...changed })).rejects.toMatchObject({
      code: "organizationId" in changed ? "configuration_not_ready" : "access_denied",
    });
  });
});
