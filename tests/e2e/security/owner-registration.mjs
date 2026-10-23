import assert from "node:assert/strict";
import { serviceContainer } from "../lifecycle-closeout/recovery-support.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function projectScope(config) {
  assert.match(config.project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  assert.equal(config.env.ANTNEST_RUNTIME_CONTROLLER_SCOPE, config.project);
  return config.project;
}

function runningContainer(container, project, service) {
  assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  assert.equal(container.Config.Labels["com.docker.compose.service"], service);
  assert.equal(container.State.Running, true);
  assert.match(container.Id, /^[0-9a-f]{64}$/u);
}

// This is process identity from one Docker daemon, not an SDK timing assertion.
// Preserve sub-millisecond digits when comparing Docker's and Go's encodings.
function processStart(value) {
  assert.equal(typeof value, "string");
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/u.exec(
    value,
  );
  assert(match, "missing Docker process start identity");
  const milliseconds = Date.parse(match[1] + "Z");
  assert(Number.isSafeInteger(milliseconds) && milliseconds > 0);
  assert.equal(new Date(milliseconds).toISOString().slice(0, 19), match[1]);
  return (
    BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"))
  );
}

export function inspectOwnerRegistration({
  config,
  registrations,
  acp,
  controller,
  engineId,
}) {
  const project = projectScope(config);
  runningContainer(acp, project, "agent-acp-service");
  runningContainer(controller, project, "runtime-controller");
  const uid = config.env.ANTNEST_SERVICE_AUTH_UID;
  const gid = config.env.ANTNEST_SERVICE_AUTH_GID;
  assert.match(uid, /^(?:0|[1-9]\d*)$/u);
  assert.match(gid, /^(?:0|[1-9]\d*)$/u);
  assert.equal(controller.Config.User, `${uid}:${gid}`);
  assert.equal(typeof engineId, "string");
  assert(
    engineId.length > 0 &&
      engineId.length <= 256 &&
      !/[\s\p{Cc}]/u.test(engineId),
  );
  assert(Array.isArray(registrations));
  assert.equal(
    registrations.length,
    1,
    "expected one persisted owner registration",
  );
  const row = registrations[0];
  assert.equal(row.controller_scope, project);
  assert.equal(row.member_id, "acp-a");
  assert.match(row.registration_id, uuid);
  assert.match(row.incarnation_id, uuid);
  assert.equal(row.nonce_digest_bytes, 32);
  assert.equal(row.engine_id, engineId);
  assert.equal(row.container_id, acp.Id);
  assert.equal(processStart(row.started_at), processStart(acp.State.StartedAt));
  for (const field of ["stop_receipt_id", "stop_reason", "stopped_at"])
    assert.equal(
      row[field],
      null,
      "a stopped registration is not a live ACP process",
    );
  return {
    registration_id: row.registration_id,
    member_id: row.member_id,
    incarnation_id: row.incarnation_id,
    controller_scope: project,
    engine_id: engineId,
    container_id: acp.Id,
    started_at: row.started_at,
    nonce_digest_bytes: row.nonce_digest_bytes,
  };
}

export async function readOwnerRegistration({ config, docker }) {
  const project = projectScope(config);
  const acp = await serviceContainer(docker, project, "agent-acp-service");
  const controller = await serviceContainer(
    docker,
    project,
    "runtime-controller",
  );
  const postgres = await serviceContainer(docker, project, "postgres");
  runningContainer(postgres, project, "postgres");
  const engineId = (await docker(["info", "--format", "{{.ID}}"])).trim();
  // Project syntax was validated above; only a fixed SELECT and the owning role
  // are permitted. Never fetch the nonce digest or arbitrary persisted payloads.
  const sql = `SELECT COALESCE(json_agg(r), '[]'::json) FROM (
    SELECT controller_scope,registration_id,member_id,incarnation_id,
      octet_length(nonce_digest) AS nonce_digest_bytes,
      engine_id,container_id,started_at,stop_receipt_id,stop_reason,stopped_at
    FROM runtime_controller.acp_incarnation_registrations
    WHERE controller_scope='${project}' AND member_id='acp-a'
  ) r`;
  const raw = await docker([
    "exec",
    "-e",
    "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000 -c timezone=UTC",
    postgres.Id,
    "psql",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "antnest_runtime_controller",
    "-d",
    "antnest_runtime_controller",
    "-c",
    sql,
  ]);
  return inspectOwnerRegistration({
    config,
    registrations: JSON.parse(raw),
    acp,
    controller,
    engineId,
  });
}
