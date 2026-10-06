import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// The Controller is real; its other service peers remain owning-service doubles.
export async function rotateControllerFixture({
  env,
  docker,
  compose,
  rebind,
  discover,
  create,
  provider,
  providerSecret,
}) {
  const legacy = env.CONTROLLER_TEST_ENCRYPTION_KEY;
  const next = randomBytes(32).toString("base64");
  const sql = async (query) =>
    docker([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "antnest_test_admin",
      "-d",
      "controller_auth_test",
      "-Atc",
      query,
    ]);
  const recreate = async () => {
    await docker(
      [
        ...compose,
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "90",
        "agent-controller",
      ],
      true,
    );
    const id = await docker([...compose, "ps", "-q", "agent-controller"]);
    const [container] = JSON.parse(await docker(["inspect", id]));
    const port = container.NetworkSettings.Ports["8120/tcp"][0];
    assert.equal(port.HostIp, "127.0.0.1");
    rebind("http://127.0.0.1:" + port.HostPort);
  };
  const saved = () =>
    discover(
      "/internal/provider-connections/" +
        provider.connection_id +
        "/discover-models",
      { organization_id: "org-1" },
    );
  env.CONTROLLER_TEST_ENCRYPTION_KEY = "";
  env.CONTROLLER_TEST_ENCRYPTION_KEYS = `local-v1:${legacy},kid2:${next}`;
  env.CONTROLLER_TEST_ENCRYPTION_ACTIVE_KID = "local-v1";
  await recreate();
  await saved();
  env.CONTROLLER_TEST_ENCRYPTION_ACTIVE_KID = "kid2";
  await recreate();
  const active = await create("/internal/provider-connections", {
    request_id: "provider-auth-active-key",
    organization_id: "org-1",
    provider_key: "deepseek",
    display_name: "Active-key fixture",
    base_url: "http://provider:8110/v1",
    credential: { method: "api_key", api_key: providerSecret },
    models: [],
  });
  assert(active.json.connection_id);
  assert.equal(
    await sql(
      "SELECT string_agg(DISTINCT key_version, ',' ORDER BY key_version) FROM agent_controller.provider_connections",
    ),
    "kid2,local-v1",
  );
  const fingerprint = () =>
    sql(
      "SELECT md5(jsonb_agg(to_jsonb(p) - 'ciphertext' - 'nonce' - 'key_version' - 'wrapped_data_key' ORDER BY id)::text) FROM agent_controller.provider_connections p",
    );
  const before = await fingerprint();
  const rekey = async () => {
    const output = await docker([
      ...compose,
      "exec",
      "-T",
      "agent-controller",
      "/usr/local/bin/agent-controller",
      "rekey",
      "--batch-size",
      "1",
    ]);
    const progress = output.split("\n").map((line) => JSON.parse(line));
    assert(progress.every((p) => p.active_kid === "kid2"));
    assert.deepEqual(
      new Set(progress.map((p) => p.table)),
      new Set(["provider_connections", "managed_mcp_secrets"]),
    );
    assert.equal(progress.at(-1).table, "managed_mcp_secrets");
    assert.equal(progress.at(-1).remaining, 0);
    assert.equal(progress.at(-1).updated, 0);
    return progress.reduce((sum, p) => sum + p.updated, 0);
  };
  assert.equal(await rekey(), 2);
  assert.equal(await rekey(), 0);
  assert.equal(await fingerprint(), before);
  assert.equal(
    await sql(
      "SELECT count(*) FROM agent_controller.provider_connections WHERE key_version<>'kid2' OR wrapped_data_key IS NULL",
    ),
    "0",
  );
  env.CONTROLLER_TEST_ENCRYPTION_KEYS = `kid2:${next}`;
  await recreate();
  await saved();
  assert.equal(await fingerprint(), before);
  return { mixed_keys: true, idempotent: true, retired_key: true };
}
