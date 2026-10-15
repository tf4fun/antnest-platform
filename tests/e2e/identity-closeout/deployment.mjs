import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
import { resolveObservationConfig } from "../observability/resolve-config.mjs";
export function inspectIdentityDeployment(
  rows,
  project,
  expectedPollInterval = "2s",
) {
  const service = (row) => row.Config.Labels["com.docker.compose.service"];
  const result = inspectDeployment(
    rows.filter((row) => service(row) !== "oidc-fixture"),
    project,
  );
  const fixtures = rows.filter((row) => service(row) === "oidc-fixture");
  assert.equal(fixtures.length, 1);
  const fixture = fixtures[0];
  assert.equal(fixture.Config.Labels["com.docker.compose.project"], project);
  assert.equal(fixture.State.Running, true);
  assert.equal(fixture.State.Health?.Status, "healthy");
  const bindings = Object.values(fixture.HostConfig.PortBindings ?? {}).flat();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
  const identity = rows.find((row) => service(row) === "identity-service");
  const gateway = rows.find((row) => service(row) === "edge-gateway");
  const ttlKey = "ANTNEST_EDGE_RESOLVE_CACHE_TTL";
  const ttlValues = (gateway.Config.Env ?? []).filter((value) =>
    value.startsWith(ttlKey + "="),
  );
  assert(ttlValues.length <= 1, "duplicate deployed Resolve TTL");
  const { resolveTTLMS } = resolveObservationConfig(
    { [ttlKey]: ttlValues[0]?.slice(ttlKey.length + 1) ?? "" },
    {},
  );
  assert(identity.Config.Env.includes("SSL_CERT_FILE=/test-ca/tls.crt"));
  assert(identity.Config.Env.includes("ANTNEST_IDENTITY_TOKEN_TTL=12h"));
  assert(
    identity.Mounts.some((m) => m.Destination === "/test-ca" && m.RW === false),
  );
  const controller = rows.find((row) => service(row) === "agent-controller");
  const pollKey = "ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL";
  const actual = controller.Config.Env.filter((value) =>
    value.startsWith(pollKey + "="),
  );
  assert.deepEqual(
    actual,
    [pollKey + "=" + expectedPollInterval],
    "Controller diagnostic poll setting differs from this run",
  );
  return {
    ...result,
    services: rows.length,
    oidc_verified_tls: true,
    resolve_cache_ttl_ms: resolveTTLMS,
    controller_identity_revocation_poll_interval: actual[0].slice(
      pollKey.length + 1,
    ),
  };
}
// Inspect both the initial and recreated container against the image selected
// independently by the owning runner. Do not derive the expected ID from rows.
export function inspectIdentityLifecycle(rows, project, { imageID, tokenTTL }) {
  assert(Array.isArray(rows));
  assert.match(imageID ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert(["12h", "5s"].includes(tokenTTL));
  const identities = rows.filter(
    (row) =>
      row.Config?.Labels?.["com.docker.compose.service"] === "identity-service",
  );
  assert.equal(identities.length, 1);
  const identity = identities[0];
  assert.equal(identity.Config.Labels["com.docker.compose.project"], project);
  assert.match(identity.Id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(identity.Image, imageID);
  assert.equal(identity.State?.Running, true);
  assert.equal(identity.State?.Health?.Status, "healthy");
  assert.deepEqual(
    identity.Config.Env.filter((s) =>
      s.startsWith("ANTNEST_IDENTITY_TOKEN_TTL="),
    ),
    ["ANTNEST_IDENTITY_TOKEN_TTL=" + tokenTTL],
  );
  assert.deepEqual(
    identity.Config.Env.filter((s) => s.startsWith("SSL_CERT_FILE=")),
    ["SSL_CERT_FILE=/test-ca/tls.crt"],
  );
  const trust = identity.Mounts.filter(
    (mount) => mount.Destination === "/test-ca",
  );
  assert.equal(trust.length, 1);
  assert.equal(trust[0].RW, false);
  return {
    project,
    service: "identity-service",
    container_id: identity.Id,
    image_id: identity.Image,
    token_ttl: tokenTTL,
    healthy: true,
    oidc_verified_tls: true,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [path, project, mode, imageID, tokenTTL] = process.argv.slice(2);
  const rows = JSON.parse(await readFile(path, "utf8"));
  if (mode === "identity-lifecycle")
    console.log(
      JSON.stringify(
        inspectIdentityLifecycle(rows, project, { imageID, tokenTTL }),
      ),
    );
  else {
    assert.equal(
      mode,
      undefined,
      "unknown Identity deployment inspection mode",
    );
    console.log(
      JSON.stringify(
        inspectIdentityDeployment(
          rows,
          project,
          process.env
            .ANTNEST_E2E_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL || "2s",
        ),
      ),
    );
  }
}
