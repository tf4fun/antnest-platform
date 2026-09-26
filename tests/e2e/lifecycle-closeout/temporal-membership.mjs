import assert from "node:assert/strict";

export function inspectSingleNodeMembership(log) {
  const records = log.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  assert(
    !records.some((row) =>
      /unable to bootstrap ringpop|failed to start ringpop/.test(row.msg ?? ""),
    ),
    "single-node membership required a failed bootstrap attempt",
  );
  const heartbeats = records.filter(
    (row) => row.msg === "Membership heartbeat upserted successfully",
  );
  assert(
    heartbeats.length >= 4,
    "missing actual Temporal membership heartbeats",
  );
  for (const row of heartbeats)
    assert.equal(
      row.address,
      "127.0.0.1",
      "membership depends on a reallocated Docker interface",
    );
  const ports = [...new Set(heartbeats.map((row) => row.port))].sort();
  assert.deepEqual(ports, [6933, 6934, 6935, 6939]);
  return { address: "127.0.0.1", roles: ports.length, bootstrap_retries: 0 };
}

export async function collectSingleNodeMembership(docker, rows) {
  const temporal = rows.find((row) => row.name === "temporal");
  assert(temporal?.running, "Temporal is not running");
  return inspectSingleNodeMembership(
    await docker(["logs", "--since", temporal.started, temporal.id]),
  );
}
