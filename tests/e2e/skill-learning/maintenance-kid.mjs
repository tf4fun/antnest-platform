import assert from "node:assert/strict";

// Probe the released RC binary without a database, Docker socket, network or
// operator credentials. A bad kid must fail at configuration validation.
export async function assertMaintenanceKidStartupRejected({
  docker,
  image,
  project,
}) {
  const kid = "release.2026";
  const output = await docker([
    "run",
    "--rm",
    "--name",
    `${project}-invalid-maintenance-kid`,
    "--label",
    `com.docker.compose.project=${project}`,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=1m",
    "-e",
    "OTEL_SDK_DISABLED=true",
    "-e",
    "ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL=postgres://fixture:fixture@unreachable/fixture",
    "-e",
    "ANTNEST_RUNTIME_MANAGEMENT_NETWORK=fixture-management",
    "-e",
    `ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS=${JSON.stringify({ keys: [{ kid, algorithm: "Ed25519", public_key_base64url: "A".repeat(43) }] })}`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-ec",
    "if /usr/local/bin/runtime-controller >/tmp/rejection.log 2>&1; then exit 1; fi\ncat /tmp/rejection.log",
  ]);
  const stopped = output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((event) => event.msg === "Runtime Controller stopped");
  assert.equal(stopped.length, 1, "missing structured startup failure");
  assert.equal(stopped[0].component, "configuration");
  assert.equal(stopped[0].error_class, "invalid_configuration");
  return { kid, rejected_at_startup: true };
}
