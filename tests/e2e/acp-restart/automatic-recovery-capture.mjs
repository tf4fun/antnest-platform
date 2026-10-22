import assert from "node:assert/strict";
import { readFile, writeFile, chmod, rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { assertAutomaticRecoveryEvidence } from "./automatic-recovery-evidence.mjs";

// Encode values before embedding them in this fixed read-only query. The SQL
// literal contains only hexadecimal digits, never opaque identity characters.
const literal = (value) => {
  assert(
    typeof value === "string" && value.length > 0 && !value.includes("\0"),
  );
  return `convert_from(decode('${Buffer.from(value, "utf8").toString("hex")}','hex'),'UTF8')`;
};
const aggregate = (select) =>
  `SELECT COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::jsonb) FROM (${select}) rows`;

export async function publishAutomaticRecoveryCheckpoint(
  checkpoint,
  snapshot,
  { signal, files = { writeFile, chmod, rename, rm } },
) {
  signal?.throwIfAborted();
  const pending = checkpoint + ".pending";
  let published = false;
  try {
    await files.writeFile(pending, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    signal?.throwIfAborted();
    await files.chmod(pending, 0o644);
    signal?.throwIfAborted();
    await files.rename(pending, checkpoint);
    published = true;
    signal?.throwIfAborted();
  } catch (error) {
    const failures = [error];
    for (const path of published ? [pending, checkpoint] : [pending]) {
      try {
        await files.rm(path, { force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "checkpoint publication and cleanup failed",
      );
    throw error;
  }
}

async function main() {
  const [expectedFile, checkpoint, directory] = process.argv.slice(2);
  assert(expectedFile && checkpoint && directory);
  const expected = JSON.parse(await readFile(expectedFile, "utf8"));
  const project = process.env.COMPOSE_PROJECT_NAME;
  assert.match(project ?? "", /^antnest-stage3-e2e-[0-9]+$/u);
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("automatic recovery capture interrupted"));
  for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
  const budget = Math.min(
    110000,
    Number(process.env.ANTNEST_E2E_DEADLINE_MS) - Date.now(),
  );
  assert(Number.isFinite(budget) && budget > 0);
  const signal = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(Math.ceil(budget)),
  ]);
  const docker = dockerClient(process.env, signal, budget);
  const observations = [];
  try {
    const container = (
      await docker([
        "ps",
        "-q",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        "label=com.docker.compose.service=postgres",
      ])
    ).trim();
    assert.match(
      container,
      /^[a-f0-9]{64}$/u,
      "expected one owned PostgreSQL container",
    );
    const organization = literal(expected.organization_id),
      agent = literal(expected.agent_id);
    const cyclesSQL =
      aggregate(`SELECT encode(convert_to(barrier_id,'UTF8'),'hex') AS barrier_hex,
      organization_id,agent_id,runtime_revision,
      encode(convert_to(runtime_execution_id,'UTF8'),'hex') AS runtime_execution_hex,
      created_at,retired_at FROM public.runtime_barrier_cycles
      WHERE organization_id=${organization} AND agent_id=${agent} ORDER BY created_at,barrier_id`);
    const receiptsSQL = aggregate(`SELECT r.organization_id,r.agent_id,
      encode(r.barrier_id,'hex') AS barrier_hex,r.runtime_revision,
      encode(r.runtime_execution_id,'hex') AS runtime_execution_hex,
      r.reason,r.request_id,r.request_fingerprint,r.actor_principal_id,r.template_id,r.template_revision,
      r.policy_revision,r.policy_mode,r.policy_cooldown_ms,r.accepted_at,r.cooldown_until,
      o.kind,o.phase,o.state,o.request_fingerprint AS operation_fingerprint,
      o.source_spec_revision_id,o.source_execution_revision_id,o.source_runtime_revision,o.target_spec_revision_id,
      o.created_at AS operation_created_at,
      src.template_id AS source_template_id,src.template_revision AS source_template_revision,
      dst.template_id AS target_template_id,dst.template_revision AS target_template_revision,
      c.request_id AS cooldown_request_id,c.accepted_at AS cooldown_accepted_at,
      c.cooldown_until AS saved_cooldown_until,s.started_at,
      r.cooldown_until=r.accepted_at+r.policy_cooldown_ms*INTERVAL '1 millisecond' AS cooldown_exact,
      (SELECT count(*) FROM agent_controller.agent_events e WHERE e.agent_id=r.agent_id
        AND e.operation_request_id=r.request_id AND e.event_type='agent_rebuild_requested') AS requested_events,
      (SELECT min(e.data->>'rebuild_reason') FROM agent_controller.agent_events e WHERE e.agent_id=r.agent_id
        AND e.operation_request_id=r.request_id AND e.event_type='agent_rebuild_requested') AS requested_reason,
      (SELECT min(e.occurred_at) FROM agent_controller.agent_events e WHERE e.agent_id=r.agent_id
        AND e.operation_request_id=r.request_id AND e.event_type='agent_rebuild_requested') AS requested_at
      FROM agent_controller.runtime_barrier_recovery_receipts r
      LEFT JOIN agent_controller.agent_lifecycle_operations o ON o.request_id=r.request_id
      LEFT JOIN agent_controller.agent_spec_revisions src ON src.id=o.source_spec_revision_id
      LEFT JOIN agent_controller.agent_spec_revisions dst ON dst.id=o.target_spec_revision_id
      LEFT JOIN agent_controller.runtime_barrier_recovery_cooldowns c ON c.agent_id=r.agent_id
      LEFT JOIN agent_controller.runtime_barrier_recovery_starts s ON s.request_id=r.request_id
      WHERE r.organization_id=${organization} AND r.agent_id=${agent} ORDER BY r.request_id`);
    const rebuildsSQL =
      aggregate(`SELECT o.request_id FROM agent_controller.agent_lifecycle_operations o
      JOIN agent_controller.agents a ON a.id=o.agent_id
      WHERE a.organization_id=${organization} AND o.agent_id=${agent} AND o.kind='rebuild' ORDER BY o.request_id`);
    const read = async (database, sql) => {
      signal.throwIfAborted();
      const owners = JSON.parse(await docker(["inspect", container]));
      assert.equal(owners.length, 1);
      const owner = owners[0];
      assert.equal(owner.Id, container);
      assert.equal(owner.State.Running, true);
      assert.equal(owner.Config.Labels["com.docker.compose.project"], project);
      assert.equal(
        owner.Config.Labels["com.docker.compose.service"],
        "postgres",
      );
      const raw = await docker([
        "exec",
        "-e",
        "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000 -c timezone=UTC",
        container,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        database,
        "-d",
        database,
        "-c",
        sql,
      ]);
      signal.throwIfAborted();
      const rows = JSON.parse(raw);
      assert(Array.isArray(rows));
      return rows;
    };
    for (;;) {
      const snapshot = {
        cycles: await read("antnest_agent_acp", cyclesSQL),
        receipts: await read("antnest_agent_controller", receiptsSQL),
        rebuilds: await read("antnest_agent_controller", rebuildsSQL),
      };
      observations.push({ at: new Date().toISOString(), ...snapshot });
      writeEvidenceFile(
        directory,
        "automatic-recovery-observations.private.json",
        JSON.stringify(observations) + "\n",
      );
      for (const rows of Object.values(snapshot))
        assert(rows.length <= 1, "duplicated recovery inventory");
      assert.notEqual(
        snapshot.receipts[0]?.state,
        "failed",
        "automatic Rebuild failed",
      );
      if (
        snapshot.cycles[0]?.retired_at &&
        snapshot.receipts[0]?.started_at &&
        snapshot.receipts[0]?.state === "completed"
      ) {
        assertAutomaticRecoveryEvidence(snapshot, expected);
        // The disposable client runs under its service-auth UID. Only these
        // credential-free binding/receipt fields cross the temporary checkpoint.
        await publishAutomaticRecoveryCheckpoint(checkpoint, snapshot, {
          signal,
        });
        return;
      }
      await delay(250, undefined, { signal });
    }
  } finally {
    abort.abort();
    for (const event of ["SIGINT", "SIGTERM"])
      process.removeListener(event, interrupt);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    const directory = process.argv[4];
    if (directory)
      writeEvidenceFile(
        directory,
        "automatic-recovery-failure.private.json",
        JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
        }) + "\n",
      );
    console.error(
      "Automatic recovery database capture failed; private observations retained",
    );
    process.exitCode = 1;
  }
}
