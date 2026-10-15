import assert from "node:assert/strict";

const scopeFields = [
  "run_id",
  "session_id",
  "organization_id",
  "agent_id",
  "principal_id",
  "bridge_intent_id",
  "execution_revision",
  "runtime_revision",
  "runtime_execution_id",
];
const database = "antnest_agent_acp";

// Admin deliberately projects out internal Runtime fields. Read only the
// accepted Run's safe binding and digest, with the owning service's DB role.
// No arbitrary SQL, credentials, endpoint or full snapshot leaves Postgres.
export async function createOutageRunSnapshotReader({
  project,
  compose,
  docker,
  containerID,
  scope,
  signal,
  now = () => performance.now(),
}) {
  assert.match(project, /^antnest-lifecycle-[a-z0-9]{8}$/u);
  const expected = Object.fromEntries(
    scopeFields.map((key) => {
      assert.match(scope[key] ?? "", /^[a-zA-Z0-9_-]+$/u);
      return [key, scope[key]];
    }),
  );
  signal?.throwIfAborted();
  // The isolated expiry fixture already discovered this owned PostgreSQL
  // container before final Resolve admission. Reuse only its identity; each
  // actual read still checks the current project, service and running state.
  const id =
    containerID === undefined
      ? await docker(compose(["ps", "-q", "postgres"]), false, {
          signal,
          timeoutMS: 15000,
        })
      : containerID;
  signal?.throwIfAborted();
  assert.match(id, /^[a-f0-9]{64}$/u);
  const evidence = { container_id: id, project, database, observations: [] };
  const sql = `SELECT jsonb_build_object(
    'run_id',r.id,'session_id',r.session_id,'organization_id',s.organization_id,
    'agent_id',s.agent_id,'principal_id',s.principal_id,'bridge_intent_id',r.bridge_intent_id,
    'state',r.state,'snapshot_organization_id',r.execution_snapshot->>'organizationId',
    'execution_revision',r.execution_snapshot->>'executionRevision',
    'runtime_revision',r.execution_snapshot->'runtime'->>'revision',
    'runtime_execution_id',r.execution_snapshot->'runtime'->>'executionId',
    'snapshot_sha256',encode(sha256(convert_to(r.execution_snapshot::text,'UTF8')),'hex')
  ) FROM runs r JOIN acp_sessions s ON s.id=r.session_id
  WHERE r.id='${expected.run_id}' AND r.session_id='${expected.session_id}'
    AND s.organization_id='${expected.organization_id}' AND s.agent_id='${expected.agent_id}'
    AND s.principal_id='${expected.principal_id}' AND r.bridge_intent_id='${expected.bridge_intent_id}'
    AND r.execution_snapshot IS NOT NULL`;
  return {
    evidence,
    async read(
      label,
      { signal: requestSignal = signal, timeoutMS = 15000 } = {},
    ) {
      assert(Number.isFinite(timeoutMS) && timeoutMS > 0);
      const started_at = now();
      const deadline = started_at + timeoutMS;
      const bounded = AbortSignal.any(
        [
          signal,
          requestSignal,
          AbortSignal.timeout(Math.ceil(timeoutMS)),
        ].filter(Boolean),
      );
      const remaining = () => {
        bounded.throwIfAborted();
        const value = deadline - now();
        assert(value > 0, "stored Run observation timed out");
        return value;
      };
      const read = async (args) => {
        const value = await docker(args, false, {
          signal: bounded,
          timeoutMS: remaining(),
        });
        remaining();
        return value;
      };
      let record;
      try {
        const rows = JSON.parse(await read(["inspect", id]));
        assert(rows.length === 1);
        const owner = rows[0];
        assert(owner.Id === id && owner.State.Running === true);
        assert(owner.Config.Labels["com.docker.compose.project"] === project);
        assert(
          owner.Config.Labels["com.docker.compose.service"] === "postgres",
        );
        const raw = await read([
          "exec",
          "-e",
          `PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=${Math.max(1, Math.floor(remaining()))}`,
          id,
          "psql",
          "-X",
          "-A",
          "-t",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          database,
          "-d",
          database,
          "-c",
          sql,
        ]);
        const lines = raw.split("\n").filter((line) => line.trim());
        assert(lines.length === 1);
        record = JSON.parse(lines[0]);
        const allowed = [
          ...scopeFields,
          "snapshot_organization_id",
          "state",
          "snapshot_sha256",
        ].sort();
        assert(
          JSON.stringify(Object.keys(record).sort()) ===
            JSON.stringify(allowed),
        );
        for (const key of scopeFields) assert(record[key] === expected[key]);
        assert(record.snapshot_organization_id === expected.organization_id);
        assert(["running", "unresolved"].includes(record.state));
        assert(/^[a-f0-9]{64}$/u.test(record.snapshot_sha256 ?? ""));
        remaining();
      } catch {
        // Never expose psql/JSON diagnostics, which can contain returned data.
        throw new Error(
          "stored Run observation failed, interrupted or timed out",
        );
      }
      const row = { label, started_at, at: now(), record };
      evidence.observations.push(row);
      return row;
    },
  };
}
