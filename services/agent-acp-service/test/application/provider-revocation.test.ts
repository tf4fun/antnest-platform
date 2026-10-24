import { expect, it, vi } from "vitest";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { snapshot } from "../support/fixtures.js";
import type { AuthenticatedModelTransport, ModelRequest } from "../../src/ports/model.js";

it("revokes in-flight and idle holders without reviving them on re-enable", async () => {
  const complete = vi.fn<AuthenticatedModelTransport["complete"]>(
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new Error("Transport aborted", { cause: request.signal.reason })),
          {
            once: true,
          },
        );
      }),
  );
  const clients = new ProviderClients({ complete });
  const config = executionConfiguration();
  clients.apply(config);
  const handle = clients.acquire("organization-1", "provider-1");
  const frozen = snapshot();
  frozen.organizationId = config.organization_id;
  frozen.providerConnectionId = config.providers[0]!.connection_id;
  frozen.executionSpec.model.baseUrl = config.providers[0]!.base_url;
  const request: ModelRequest = {
    snapshot: frozen,
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  };
  const running = handle.complete(request);
  const rejected = expect(running).rejects.toMatchObject({ code: "provider_unavailable" });
  try {
    // Exercise revocation of an actual in-flight request, not an earlier
    // routing rejection caused by an unrelated generic snapshot fixture.
    expect(complete).toHaveBeenCalledTimes(1);
    clients.apply({
      ...config,
      revision: 2,
      providers: config.providers.map((p) => ({ ...p, enabled: false })),
    });
    expect(handle.signal.aborted).toBe(true);
    await rejected;
    clients.apply({ ...config, revision: 3 });
    await expect(handle.complete(request)).rejects.toMatchObject({ code: "provider_unavailable" });
    const fresh = clients.acquire("organization-1", "provider-1");
    try {
      expect(fresh.signal.aborted).toBe(false);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      fresh.release();
    }
  } finally {
    clients.apply({ ...config, revision: 4, providers: [], models: [], agents: [] });
    handle.release();
    await running.catch(() => undefined);
    await rejected;
  }
});
