import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GatewayClient } from "../identity-closeout/support.mjs";
import {
  seedLegacyOIDCSecrets,
  oidcBusinessFingerprintSQL,
  parseRekeyProgress,
} from "../../support/encryption-fixtures.mjs";

export async function rotatePlatformKeys({ config, docker, compose, fixture }) {
  const beforeAgent = await fixture.ready();
  const runtime = async () => {
    const id = await docker([
      "ps",
      "-q",
      "--filter",
      `label=io.antnest.agent-id=${fixture.agentID}`,
      "--filter",
      `label=io.antnest.runtime-controller-scope=${config.project}`,
    ]);
    assert.match(id, /^[a-f0-9]+$/u);
    const [container] = JSON.parse(await docker(["inspect", id]));
    assert.equal(container.State.Running, true);
    return {
      id: container.Id,
      started_at: container.State.StartedAt,
      restarts: container.RestartCount,
      spec_digest: container.Config.Labels["io.antnest.runtime-spec-digest"],
    };
  };
  const beforeRuntime = await runtime();
  const principal = (await fixture.json("/api/session")).principal;
  const postgres = await docker(compose(["ps", "-q", "postgres"]));
  assert(postgres);
  const sql = (owner, query) =>
    docker([
      "exec",
      "-e",
      `PGPASSWORD=${config.env[`ANTNEST_${owner.toUpperCase()}_POSTGRES_PASSWORD`]}`,
      postgres,
      "psql",
      "-U",
      `antnest_${owner}`,
      "-d",
      `antnest_${owner}`,
      "-Atc",
      query,
    ]);
  const identitySQL = (query) => sql("identity", query);
  await seedLegacyOIDCSecrets({
    sql: identitySQL,
    key: config.env.ANTNEST_IDENTITY_ENCRYPTION_KEY,
    organizationID: principal.organization_id,
  });
  const providerFingerprintSQL =
    "SELECT md5(jsonb_agg(to_jsonb(p) - 'ciphertext' - 'nonce' - 'key_version' - 'wrapped_data_key' ORDER BY id)::text) FROM agent_controller.provider_connections p";
  const fingerprints = async () => [
    await sql("agent_controller", providerFingerprintSQL),
    await identitySQL(oidcBusinessFingerprintSQL),
  ];
  const before = await fingerprints();
  const next = new Map();
  for (const prefix of ["ANTNEST_IDENTITY", "ANTNEST_AGENT_CONTROLLER"]) {
    const legacy = config.env[`${prefix}_ENCRYPTION_KEY`];
    assert(legacy);
    next.set(prefix, randomBytes(32).toString("base64"));
    config.env[`${prefix}_ENCRYPTION_KEY`] = "";
    config.env[`${prefix}_ENCRYPTION_KEYS`] =
      `local-v1:${legacy},kid2:${next.get(prefix)}`;
    config.env[`${prefix}_ENCRYPTION_ACTIVE_KID`] = "local-v1";
  }
  const recreate = async () => {
    await docker(
      compose([
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "identity-service",
        "agent-controller",
      ]),
      true,
    );
    await fixture.ready();
    await fixture.state();
    assert.deepEqual(
      await runtime(),
      beforeRuntime,
      "key rotation replaced or restarted the existing Runtime",
    );
  };
  const connections = (await fixture.json("/api/admin/provider-connections"))
    .items;
  assert.equal(connections.length, 1);
  const discover = async () => {
    const result = await fixture.json(
      `/api/admin/provider-connections/${connections[0].connection_id}/models/discovery`,
    );
    assert.equal(result.models[0].model_id, "stage3-model");
  };
  await recreate();
  await discover();
  for (const prefix of next.keys())
    config.env[`${prefix}_ENCRYPTION_ACTIVE_KID`] = "kid2";
  await recreate();
  const rekey = async (service, tables) =>
    parseRekeyProgress(
      await docker(
        compose([
          "exec",
          "-T",
          service,
          `/usr/local/bin/${service}`,
          "rekey",
          "--batch-size",
          "1",
        ]),
      ),
      "kid2",
      tables,
    );
  assert.equal(await rekey("agent-controller", ["provider_connections"]), 1);
  assert.equal(
    await rekey("identity-service", ["oidc_providers", "oidc_auth_sessions"]),
    2,
  );
  assert.equal(await rekey("agent-controller", ["provider_connections"]), 0);
  assert.equal(
    await rekey("identity-service", ["oidc_providers", "oidc_auth_sessions"]),
    0,
  );
  assert.deepEqual(await fingerprints(), before);
  assert.equal(
    await sql(
      "agent_controller",
      "SELECT count(*) FROM agent_controller.provider_connections WHERE key_version<>'kid2' OR wrapped_data_key IS NULL",
    ),
    "0",
  );
  assert.equal(
    await identitySQL(`SELECT
    (SELECT count(*) FROM oidc_providers WHERE client_secret_key_id<>'kid2' OR client_secret_wrapped_data_key IS NULL),
    (SELECT count(*) FROM oidc_auth_sessions WHERE secret_key_id<>'kid2' OR secret_wrapped_data_key IS NULL)`),
    "0|0",
  );
  for (const [prefix, key] of next)
    config.env[`${prefix}_ENCRYPTION_KEYS`] = `kid2:${key}`;
  await recreate();
  await discover();
  assert.deepEqual(await fingerprints(), before);
  const afterAgent = await fixture.ready();
  assert.equal(afterAgent.agent_spec_revision, beforeAgent.agent_spec_revision);
  assert.equal(
    afterAgent.executable_execution_revision,
    beforeAgent.executable_execution_revision,
  );
  assert.equal(
    afterAgent.runtime.runtime_revision,
    beforeAgent.runtime.runtime_revision,
  );
  const fresh = new GatewayClient(config.gateway);
  const login = await fresh.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  assert.deepEqual(login.body.principal, principal);
  const model = await fetch(`${config.model}/status`, {
    signal: AbortSignal.timeout(5000),
  }).then((response) => response.json());
  assert.deepEqual(model.errors, []);
  return {
    controller_updated: 1,
    identity_updated: 2,
    remaining: 0,
    idempotent: true,
    retired_key: true,
    existing_runtime_unchanged: true,
    login_usable: true,
    provider_authenticated_after_retirement: true,
    external_provider_requests: 0,
  };
}
