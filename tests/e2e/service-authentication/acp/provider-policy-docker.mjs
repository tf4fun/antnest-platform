import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function providerPolicyChecks({
  docker,
  service,
  prefix,
  cleanup,
  signal,
  fixtureOrigin,
}) {
  const network = prefix + "-provider-network";
  const provider = prefix + "-provider";
  const subnet = `100.${128 + (randomBytes(1)[0] % 128)}.${randomBytes(1)[0]}.0/24`;
  await docker([
    "network",
    "create",
    "--internal",
    "--subnet",
    subnet,
    network,
  ]);
  cleanup.push(["network", "rm", network]);
  await docker(["network", "connect", network, service]);
  cleanup.push(["network", "disconnect", "--force", network, service]);
  cleanup.push(["rm", "--force", "--volumes", provider]);
  await docker([
    "run",
    "--detach",
    "--name",
    provider,
    "--network",
    network,
    "--network-alias",
    "provider-model-fixture",
    // Docker Desktop and OrbStack resolve this name implicitly; Linux engines
    // need the mapping for the relay to reach the host model handler.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--env",
    `FIXTURE_ORIGIN=${fixtureOrigin}`,
    "--volume",
    fileURLToPath(new URL("./provider.mjs", import.meta.url)) +
      ":/fixture/provider.mjs:ro",
    "node:24.21.0-bookworm-slim",
    "node",
    "/fixture/provider.mjs",
  ]);
  await docker([
    "network",
    "connect",
    "--alias",
    "private-provider-model-fixture",
    prefix,
    provider,
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    signal.throwIfAborted();
    try {
      await docker([
        "exec",
        provider,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8110/test/state').then(r=>r.text()).then(()=>process.exit(0)).catch(()=>process.exit(1))",
      ]);
      ready = true;
      break;
    } catch {
      await delay(100, undefined, { signal });
    }
  }
  assert(ready, "isolated Provider did not start");
  // Execute the production adapter in the production image, with default policy.
  // No live model, Provider key, decrypted user credential or Internet access.
  const script = `
    import assert from "node:assert/strict";
    import { OpenAICompatibleModel } from "./dist/adapters/model/openai-compatible.js";
    import { loadConfig } from "./dist/config.js";
    for (const [value, expected] of [[undefined, false], ["false", false], ["true", true]]) {
      const config = loadConfig({ ...process.env, ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: value });
      assert.equal(config.providerAllowPrivateEndpoints, expected);
      await config.authentication.workload.close();
    }
    for (const value of ["", " true", "TRUE", "false "])
      assert.throws(() => loadConfig({ ...process.env, ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: value }), /ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS/);
    const records = [];
    async function probe(name, baseUrl, options = {}, expected = null, purpose) {
      const input = {
        snapshot: { executionSpec: { model: { baseUrl, model: "fixture", contextWindow: 64000, maxOutputTokens: 128, supportsImages: false } } },
        credential: "synthetic-provider-secret", messages: [{ role: "user", content: [{ type: "text", text: "provider-policy-fixture" }] }],
        tools: [], signal: AbortSignal.timeout(15000), ...(purpose ? { purpose } : {}),
      };
      let error;
      try {
        const result = await new OpenAICompatibleModel(options).complete(input);
        assert.equal(expected, null, name + " unexpectedly sent a model request");
        assert.equal(result.kind, "message");
      } catch (caught) {
        if (!expected) throw caught;
        error = caught;
        assert.equal(error.code, expected, name);
        assert(!error.message.includes("synthetic-provider-secret"));
        assert(!error.message.includes(baseUrl));
      }
      records.push({ name, code: error?.code ?? "allowed", retryable: error?.retryable ?? false });
    }
    const origin = "http://provider-model-fixture:8110";
    await probe("public-default", origin + "/v1");
    await probe("public-learning", origin + "/v1", {}, null, "skill_learning");
    await probe("redirect-without-following", origin + "/redirect", {}, "model_http_error");
    await probe("DNS-unavailable", "http://missing-provider.invalid/v1", {}, "provider_endpoint_unavailable");
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "[fd00:ec2::254]", "[::ffff:127.0.0.1]"])
      await probe("private-" + address, "http://" + address + "/v1", {}, "provider_endpoint_forbidden");
    await probe("Identity-private-origin", ${JSON.stringify(fixtureOrigin)} + "/v1", {}, "provider_endpoint_forbidden");
    await probe("private-Docker-origin", "http://private-provider-model-fixture:8110/v1", {}, "provider_endpoint_forbidden");
    await probe("operator-private-opt-in", "http://private-provider-model-fixture:8110/v1", { destination: { allowPrivateEndpoints: true } });
    process.stdout.write(JSON.stringify(records));
  `;
  const records = JSON.parse(
    await docker([
      "exec",
      "-e",
      "HTTP_PROXY=http://127.0.0.1:8080",
      "-e",
      "HTTPS_PROXY=http://127.0.0.1:8080",
      "-e",
      "ALL_PROXY=http://127.0.0.1:8080",
      service,
      "node",
      "--input-type=module",
      "-e",
      script,
    ]),
  );
  assert.equal(records.length, 13);
  const state = JSON.parse(
    await docker([
      "exec",
      provider,
      "node",
      "-e",
      "fetch('http://127.0.0.1:8110/test/state').then(r=>r.text()).then(v=>process.stdout.write(v))",
    ]),
  );
  assert.deepEqual(state, { calls: 4, failures: 0, redirects: 1 });
  assert.equal(
    records.find((item) => item.name === "DNS-unavailable").retryable,
    true,
  );
  assert(
    records
      .filter((item) => item.code === "provider_endpoint_forbidden")
      .every((item) => item.retryable === false),
  );
  return {
    checks: records.length + 10,
    baseUrl: "http://private-provider-model-fixture:8110/relay/v1",
  };
}
