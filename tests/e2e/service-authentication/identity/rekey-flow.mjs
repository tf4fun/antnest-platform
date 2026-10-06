import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  seedLegacyOIDCSecrets,
  oidcBusinessFingerprintSQL,
  parseRekeyProgress,
} from "../../../support/encryption-fixtures.mjs";

export async function rotateIdentityFixture({
  env,
  docker,
  compose,
  rebind,
  login,
  organizationID,
}) {
  const legacy = env.IDENTITY_TEST_ENCRYPTION_KEY;
  const next = randomBytes(32).toString("base64");
  const sql = (query) =>
    docker([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "antnest_identity",
      "-d",
      "identity_auth_test",
      "-Atc",
      query,
    ]);
  await seedLegacyOIDCSecrets({ sql, key: legacy, organizationID });
  const before = await sql(oidcBusinessFingerprintSQL);
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
        "identity-service",
      ],
      true,
    );
    const id = await docker([...compose, "ps", "-q", "identity-service"]);
    const [container] = JSON.parse(await docker(["inspect", id]));
    const port = container.NetworkSettings.Ports["8080/tcp"][0];
    assert.equal(port.HostIp, "127.0.0.1");
    rebind("http://127.0.0.1:" + port.HostPort);
  };
  env.IDENTITY_TEST_ENCRYPTION_KEY = "";
  env.IDENTITY_TEST_ENCRYPTION_KEYS = `local-v1:${legacy},kid2:${next}`;
  env.IDENTITY_TEST_ENCRYPTION_ACTIVE_KID = "local-v1";
  await recreate();
  await login();
  env.IDENTITY_TEST_ENCRYPTION_ACTIVE_KID = "kid2";
  await recreate();
  const rekey = async () =>
    parseRekeyProgress(
      await docker([
        ...compose,
        "exec",
        "-T",
        "identity-service",
        "/usr/local/bin/identity-service",
        "rekey",
        "--batch-size",
        "1",
      ]),
      "kid2",
      ["oidc_providers", "oidc_auth_sessions"],
    );
  assert.equal(await rekey(), 2);
  assert.equal(await rekey(), 0);
  assert.equal(await sql(oidcBusinessFingerprintSQL), before);
  assert.equal(
    await sql(`SELECT
    (SELECT count(*) FROM oidc_providers WHERE client_secret_key_id<>'kid2' OR client_secret_wrapped_data_key IS NULL),
    (SELECT count(*) FROM oidc_auth_sessions WHERE secret_key_id<>'kid2' OR secret_wrapped_data_key IS NULL)`),
    "0|0",
  );
  env.IDENTITY_TEST_ENCRYPTION_KEYS = `kid2:${next}`;
  await recreate();
  await login();
  assert.equal(await sql(oidcBusinessFingerprintSQL), before);
  return { legacy_tables: 2, idempotent: true, retired_key: true };
}
