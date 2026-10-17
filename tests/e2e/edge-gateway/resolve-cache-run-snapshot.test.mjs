import assert from "node:assert/strict";
import test from "node:test";

const scope = {
  run_id: "run-1",
  session_id: "session-1",
  organization_id: "organization-1",
  agent_id: "agent-1",
  principal_id: "user-1",
  bridge_intent_id: "intent-1",
  execution_revision: "execution-1",
  runtime_revision: "rtv-1",
  runtime_execution_id: "runtime-1",
};
const project = "antnest-lifecycle-12345678";
const containerID = "a".repeat(64);
const stored = () => ({
  ...scope,
  snapshot_organization_id: scope.organization_id,
  state: "running",
  snapshot_sha256: "b".repeat(64),
});
const ownership = () => [
  {
    Id: containerID,
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "postgres",
      },
    },
    State: { Running: true },
  },
];
async function setup({
  inspect = ownership,
  query = () => JSON.stringify(stored()),
  signal,
  now,
  preparedContainer,
} = {}) {
  const calls = [];
  const { createOutageRunSnapshotReader } =
    await import("./resolve-cache-run-snapshot.mjs");
  const reader = await createOutageRunSnapshotReader({
    project,
    scope,
    signal,
    now,
    containerID: preparedContainer,
    compose: (args) => ["compose", ...args],
    docker: async (args, long, options) => {
      calls.push({ args, long, options });
      if (args[0] === "compose") return containerID;
      if (args[0] === "inspect") return JSON.stringify(await inspect(options));
      assert.equal(args[0], "exec");
      return query(args, options);
    },
  });
  return { reader, calls };
}

test("prepared PostgreSQL identity avoids discovery on the warm budget but still verifies ownership", async () => {
  const { reader, calls } = await setup({ preparedContainer: containerID });
  assert.deepEqual(calls, []);
  const row = await reader.read("before-stop");
  assert.equal(row.record.run_id, scope.run_id);
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ["inspect", "exec"],
  );
});

test("invalid prepared PostgreSQL identity cannot fall back to fresh discovery", async () => {
  for (const preparedContainer of [null, false, "", "other", "g".repeat(64)]) {
    await assert.rejects(setup({ preparedContainer }));
  }
});

test("reads only the exact stored Run binding with its owning DB role and read-only SQL", async () => {
  const { reader, calls } = await setup();
  const row = await reader.read("before-stop");
  assert.deepEqual(row.record, stored());
  assert(row.at >= row.started_at);
  assert.equal(reader.evidence.container_id, containerID);
  assert.equal(reader.evidence.database, "antnest_agent_acp");
  const exec = calls.find((c) => c.args[0] === "exec");
  assert.equal(exec.args[exec.args.indexOf("-U") + 1], "antnest_agent_acp");
  assert.equal(exec.args[exec.args.indexOf("-d") + 1], "antnest_agent_acp");
  assert(
    exec.args.some(
      (v) =>
        v.includes("default_transaction_read_only=on") &&
        v.includes("statement_timeout="),
    ),
  );
  const sql = exec.args.at(-1);
  assert.match(sql, /^SELECT /u);
  for (const value of Object.values(scope).slice(0, 6))
    assert(sql.includes(`'${value}'`));
  assert.match(sql, /sha256\(convert_to\(r\.execution_snapshot::text/u);
  assert.doesNotMatch(
    sql,
    /SELECT\s+\*|to_jsonb\(r\)|authorization|bearerToken|mcpEndpoint/iu,
  );
  assert(exec.options.signal instanceof AbortSignal);
  assert(exec.options.timeoutMS > 0 && exec.options.timeoutMS <= 15000);
});

for (const field of [...Object.keys(scope), "snapshot_organization_id"]) {
  test(`rejects a returned foreign ${field} instead of recording it`, async () => {
    const { reader } = await setup({
      query: () => JSON.stringify({ ...stored(), [field]: "foreign" }),
    });
    await assert.rejects(reader.read("before-stop"));
    assert.deepEqual(reader.evidence.observations, []);
  });
}
for (const preparedContainer of [undefined, containerID]) {
  for (const mutate of [
    (row) => (row.Config.Labels["com.docker.compose.project"] = "foreign"),
    (row) =>
      (row.Config.Labels["com.docker.compose.service"] = "identity-service"),
    (row) => (row.State.Running = false),
    (row) => (row.Id = "c".repeat(64)),
  ]) {
    test("rejects changed database ownership before dispatching SQL", async () => {
      const { reader, calls } = await setup({
        preparedContainer,
        inspect: () => {
          const rows = ownership();
          mutate(rows[0]);
          return rows;
        },
      });
      await assert.rejects(reader.read("before-stop"));
      assert.equal(calls.filter((c) => c.args[0] === "exec").length, 0);
    });
  }
}
test("does not retain unexpected secret fields or echo SQL failure diagnostics", async () => {
  for (const query of [
    () => JSON.stringify({ ...stored(), credential: "private-secret" }),
    () => {
      throw new Error("password private-secret in SQL diagnostic");
    },
    () => "private-secret invalid JSON",
    () => JSON.stringify(stored()) + "\n" + JSON.stringify(stored()),
  ]) {
    const { reader } = await setup({ query });
    const error = await reader.read("before-stop").then(
      () => null,
      (e) => e,
    );
    assert(error instanceof Error);
    assert(!String(error.stack).includes("private-secret"));
    assert.equal(error.cause, undefined);
    assert.deepEqual(reader.evidence.observations, []);
  }
});
test("the original deadline includes ownership reads and rejects a late result", async () => {
  let budget,
    instant = 0;
  const { reader } = await setup({
    now: () => instant,
    inspect: () => {
      instant += 30;
      return ownership();
    },
    query: (args, options) => {
      budget = options.timeoutMS;
      instant += 100;
      return JSON.stringify(stored());
    },
  });
  await assert.rejects(reader.read("before-stop", { timeoutMS: 100 }));
  assert.equal(budget, 70);
  assert.deepEqual(reader.evidence.observations, []);
});
test("an interrupted ownership read cannot dispatch the SQL or record success", async () => {
  const controller = new AbortController();
  const { reader, calls } = await setup({
    inspect: () => {
      controller.abort();
      return ownership();
    },
  });
  await assert.rejects(
    reader.read("before-stop", { signal: controller.signal }),
  );
  assert.equal(calls.filter((c) => c.args[0] === "exec").length, 0);
});
