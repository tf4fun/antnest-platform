import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
export function inspectIdentityDeployment(rows, project) {
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
  assert(identity.Config.Env.includes("SSL_CERT_FILE=/test-ca/tls.crt"));
  assert(identity.Config.Env.includes("ANTNEST_IDENTITY_TOKEN_TTL=12h"));
  assert(
    identity.Mounts.some((m) => m.Destination === "/test-ca" && m.RW === false),
  );
  return { ...result, services: rows.length, oidc_verified_tls: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify(
      inspectIdentityDeployment(
        JSON.parse(await readFile(process.argv[2], "utf8")),
        process.argv[3],
      ),
    ),
  );
