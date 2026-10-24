import assert from "node:assert/strict";

const services = new Set([
  "agent-acp-service",
  "agent-acp-peer-b",
  "runtime-controller",
  "postgres",
]);
const members = new Set(["acp-a", "acp-b"]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uuid = (value) => {
  assert.equal(typeof value, "string");
  assert.equal(uuidPattern.exec(value)?.[0], value);
  return value;
};
const literal = (value) => {
  assert.equal(typeof value, "string");
  assert.equal(/^[A-Za-z0-9_-]{1,200}$/u.exec(value)?.[0], value);
  return `'${value}'`;
};
const position = (value) => {
  assert.equal(typeof value, "string");
  assert(value.length <= 19);
  assert.equal(/^(?:0|[1-9][0-9]*)$/u.exec(value)?.[0], value);
  const number = BigInt(value);
  assert(number <= 9223372036854775807n);
  return number;
};

// This fixed program reads credentials only inside the live A container. Neither
// command arguments nor stdout/stderr contain the credential or request headers.
const rcProgram = `
const { readFileSync } = require("node:fs");
(async () => {
  try {
    const input = JSON.parse(process.argv[1]);
    if (input.operation !== "inspect" && input.operation !== "history") throw new Error();
    const token = readFileSync("/etc/antnest/service-auth/tokens/runtime-controller", "utf8");
    if (token.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    const history = input.operation === "history";
    const path = history ? "/internal/acp-incarnations/history" :
      "/internal/acp-incarnations/" + input.registrationId;
    const response = await fetch("http://runtime-controller:8080" + path, {
      method: history ? "POST" : "GET",
      redirect: "error",
      credentials: "omit",
      headers: {
        "Antnest-Service-Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Connection": "close"
      },
      ...(history ? { body: JSON.stringify({ member_id: input.memberId, cursor: input.cursor }) } : {}),
      signal: AbortSignal.timeout(5000)
    });
    const raw = await response.text();
    if (raw.includes(token)) throw new Error();
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    process.stdout.write(JSON.stringify({ status: response.status, body }));
  } catch {
    process.stderr.write("Survivor RC request failed");
    process.exitCode = 1;
  }
})();
`;

export async function createSurvivorJournal(config, docker) {
  const project = config.project;
  assert.equal(typeof project, "string");
  assert.equal(/^antnest-lifecycle-[a-f0-9]{8}$/u.exec(project)?.[0], project);
  assert.equal(config.env.ANTNEST_RUNTIME_CONTROLLER_SCOPE, project);

  const service = async (name) => {
    assert(services.has(name), "Unsupported survivor service");
    const ids = (
      await docker([
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${name}`,
      ])
    )
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    assert.equal(ids.length, 1, `${name}: expected one owned service`);
    assert.match(ids[0], /^[a-f0-9]{64}$/u);
    const rows = JSON.parse(await docker(["inspect", ids[0]]));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.Id, ids[0]);
    assert.equal(row.Config.Labels["com.docker.compose.project"], project);
    assert.equal(row.Config.Labels["com.docker.compose.service"], name);
    return row;
  };
  const postgres = (await service("postgres")).Id;
  const query = async (database, select) => {
    assert(
      ["antnest_agent_acp", "antnest_runtime_controller"].includes(database),
    );
    const current = await service("postgres");
    assert.equal(current.Id, postgres, "Original PostgreSQL container changed");
    assert.equal(current.State.Running, true);
    const raw = await docker([
      "exec",
      "-e",
      "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000 -c timezone=UTC",
      postgres,
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
      `SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (${select}) r`,
    ]);
    const rows = JSON.parse(raw);
    assert(Array.isArray(rows));
    return rows;
  };
  const rc = async (input) => {
    const a = await service("agent-acp-service");
    assert.equal(a.State.Running, true, "RC evidence requires live ingress A");
    const raw = await docker([
      "exec",
      a.Id,
      "node",
      "-e",
      rcProgram,
      JSON.stringify(input),
    ]);
    const result = JSON.parse(raw);
    assert(
      Number.isInteger(result.status) &&
        result.status >= 100 &&
        result.status <= 599,
    );
    assert(Object.hasOwn(result, "body"));
    return result;
  };

  return {
    service,
    registrations: () =>
      query(
        "antnest_runtime_controller",
        `SELECT controller_scope,registration_id,member_id,incarnation_id,
          engine_id,container_id,started_at,stop_receipt_id,stop_reason,stopped_at,
          octet_length(nonce_digest) AS nonce_digest_bytes
        FROM runtime_controller.acp_incarnation_registrations
        WHERE controller_scope='${project}' AND member_id IN ('acp-a','acp-b')
        ORDER BY member_id,started_at,registration_id`,
      ),
    async lease(agentId) {
      const rows = await query(
        "antnest_agent_acp",
        `SELECT owner_instance_id,epoch::text,expires_at::text,
          expires_at>clock_timestamp() AS live
        FROM agent_leases WHERE agent_id=${literal(agentId)}`,
      );
      assert(rows.length <= 1, "Agent lease identity is ambiguous");
      return rows[0] ?? null;
    },
    runs: (agentId) =>
      query(
        "antnest_agent_acp",
        `SELECT r.id,r.session_id,r.state,r.terminal_class,r.executor_state,
          r.tool_effect_state,r.error_class,r.execution_owner_registration_id,
          r.execution_owner_member_id,r.execution_owner_incarnation_id,
          r.execution_owner_epoch::text
        FROM runs r JOIN acp_sessions s ON s.id=r.session_id
        WHERE s.agent_id=${literal(agentId)} ORDER BY r.created_at,r.id`,
      ),
    recoveries: (runId) =>
      query(
        "antnest_agent_acp",
        `SELECT run_id,receipt_id,organization_id,agent_id,
          original_registration_id,original_member_id,original_incarnation_id,original_epoch::text,
          recovering_registration_id,recovering_member_id,recovering_incarnation_id,recovering_epoch::text
        FROM run_owner_recoveries WHERE run_id=${literal(runId)}`,
      ),
    stopReceipts: (registrationId) =>
      query(
        "antnest_agent_acp",
        `SELECT receipt_id,registration_id,inspection FROM owner_stop_receipts
        WHERE registration_id=${literal(uuid(registrationId))}`,
      ),
    async clockAfter(rawExpiry) {
      assert.equal(typeof rawExpiry, "string");
      // PGOPTIONS timezone=UTC produces this format. Validate calendar seconds,
      // but retain the original microseconds in the actual SQL comparison.
      const match =
        /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?(?:Z|\+00(?::?00)?)$/u.exec(
          rawExpiry,
        );
      assert(match && match[0] === rawExpiry);
      assert.equal(
        new Date(`${match[1]}T${match[2]}Z`).toISOString().slice(0, 19),
        `${match[1]}T${match[2]}`,
      );
      const rows = await query(
        "antnest_agent_acp",
        `SELECT clock_timestamp()>='${rawExpiry}'::timestamptz AS passed`,
      );
      assert.equal(rows.length, 1);
      assert.equal(typeof rows[0].passed, "boolean");
      return rows[0].passed;
    },
    rcInspect: (registrationId) =>
      rc({ operation: "inspect", registrationId: uuid(registrationId) }),
    async history(memberId) {
      assert(members.has(memberId), "Unsupported survivor member");
      const pages = [],
        cursors = new Set(),
        registrations = new Set(),
        incarnations = new Set();
      let cursor = null,
        historyId,
        revision;
      for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
        const response = await rc({ operation: "history", memberId, cursor });
        assert.equal(response.status, 200, "RC member history request failed");
        const page = response.body;
        assert(page && typeof page === "object" && !Array.isArray(page));
        assert.equal(page.member_id, memberId);
        uuid(page.history_id);
        const snapshot = position(page.snapshot_revision),
          after = position(page.after_sequence);
        historyId ??= page.history_id;
        revision ??= page.snapshot_revision;
        assert.equal(page.history_id, historyId);
        assert.equal(page.snapshot_revision, revision);
        assert.equal(page.after_sequence, cursor?.after_sequence ?? "0");
        assert(after <= snapshot);
        assert(Array.isArray(page.items));
        const remaining = snapshot - after;
        assert.equal(
          page.items.length,
          Number(remaining > 64n ? 64n : remaining),
        );
        for (const [index, item] of page.items.entries()) {
          assert.equal(item.sequence, String(after + BigInt(index) + 1n));
          assert.equal(item.registration.member_id, memberId);
          const registered = uuid(item.registration.registration_id),
            incarnation = uuid(item.registration.incarnation_id);
          assert(
            !registrations.has(registered) && !incarnations.has(incarnation),
          );
          registrations.add(registered);
          incarnations.add(incarnation);
        }
        pages.push(page);
        const last = after + BigInt(page.items.length);
        if (last === snapshot) {
          assert.equal(page.next_cursor, null);
          return pages;
        }
        const next = page.next_cursor;
        assert(next && typeof next === "object" && !Array.isArray(next));
        assert.deepEqual(Object.keys(next).sort(), [
          "after_sequence",
          "history_id",
          "snapshot_revision",
        ]);
        assert.equal(next.history_id, historyId);
        assert.equal(next.snapshot_revision, revision);
        assert.equal(next.after_sequence, String(last));
        const key = JSON.stringify([
          next.history_id,
          next.snapshot_revision,
          next.after_sequence,
        ]);
        assert(!cursors.has(key), "RC history repeated a cursor");
        cursors.add(key);
        cursor = next;
      }
      throw new Error("RC member history exceeded 64 pages");
    },
  };
}
