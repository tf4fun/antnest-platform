import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const columns = ["idle_expires_at", "expires_at", "last_used_at", "issued_at"];
const metadata = (alias) =>
  `jsonb_build_object(${columns.map((name) => `'${name}',${alias}.${name}`).join(",")})`;
const mark = () => ({ at: performance.now(), observed_at_ms: Date.now() });

// Only the newly issued, otherwise unused browser token is eligible. The
// atomic UPDATE locks the full binding and changes idle alone in an owned DB.
// No process-wide policy/restart, revocation, activity or warm-token edit.
export async function shortenIdleSession({
  project,
  compose,
  docker,
  token,
  principal,
  idleMS,
  secrets,
  protectedTokens,
  otherMembership,
}) {
  assert.match(project, /^antnest-lifecycle-[a-z0-9]{8}$/u);
  assert(Number.isInteger(idleMS) && idleMS > 0 && idleMS <= 2000);
  assert(typeof token === "string" && token.length > 0);
  const hash = createHash("sha256").update(token).digest("hex");
  secrets.push(hash);
  assert.equal(protectedTokens.length, 2);
  assert.equal(new Set([token, ...protectedTokens]).size, 3);
  const protectedHashes = protectedTokens.map((value) => {
    assert(typeof value === "string" && value.length > 0);
    return createHash("sha256").update(value).digest("hex");
  });
  secrets.push(...protectedHashes);
  assert.match(otherMembership ?? "", /^[a-zA-Z0-9_-]+$/u);
  assert.notEqual(otherMembership, principal.membership_id);
  const binding = [`token_hash='${hash}'`];
  for (const field of ["user_id", "organization_id", "membership_id"]) {
    assert.match(principal[field] ?? "", /^[a-zA-Z0-9_-]+$/u);
    binding.push(`${field}='${principal[field]}'`);
  }
  binding.push("kind='browser'", "revoked_at IS NULL");
  const where = binding.join(" AND ");
  const id = await docker(compose(["ps", "-q", "postgres"]));
  assert.match(id, /^[a-f0-9]{64}$/u);
  const ownership = async () => {
    const rows = JSON.parse(await docker(["inspect", id]));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.Id, id);
    assert.equal(row.Config.Labels["com.docker.compose.project"], project);
    assert.equal(row.Config.Labels["com.docker.compose.service"], "postgres");
    assert.equal(row.State.Running, true);
  };
  const query = async (sql) => {
    await ownership();
    let output;
    try {
      output = await docker([
        "exec",
        id,
        "psql",
        "-X",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "antnest_identity",
        "-c",
        sql,
      ]);
    } catch {
      // psql diagnostics may echo the token hash/binding. Do not attach cause.
      throw new Error("isolated browser expiry SQL failed");
    }
    const lines = output.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(
      lines.length,
      1,
      "one bound browser session observation required",
    );
    try {
      return JSON.parse(lines[0]);
    } catch {
      throw new Error("isolated browser expiry SQL response invalid");
    }
  };
  const statement = (predicate) => `WITH target AS MATERIALIZED (
    SELECT a.*, clock_timestamp() AS observed_at FROM api_tokens a
    WHERE ${predicate} FOR UPDATE
  ), changed AS (
    UPDATE api_tokens a SET idle_expires_at=t.observed_at+interval '${idleMS} milliseconds'
    FROM target t WHERE a.id=t.id
      AND t.observed_at+interval '${idleMS} milliseconds' < t.idle_expires_at
      AND t.observed_at+interval '${idleMS} milliseconds' < t.expires_at
    RETURNING a.*
  ) SELECT jsonb_build_object(
    'matches',(SELECT count(*) FROM target),
    'updated',(SELECT count(*) FROM changed),
    'before',(SELECT ${metadata("t")} FROM target t),
    'after',(SELECT ${metadata("c")} FROM changed c),
    'only_idle_changed',(SELECT (to_jsonb(c)-'idle_expires_at') =
      (to_jsonb(t)-'idle_expires_at'-'observed_at') FROM changed c JOIN target t ON c.id=t.id)
  )`;
  // Full rows are compared only in memory. No hash/SID/row contents enter an
  // assertion diff or durable evidence, including when isolation fails.
  const snapshot = () =>
    query(`SELECT jsonb_build_object(
    'target',(SELECT to_jsonb(a) FROM api_tokens a WHERE ${where}),
    'protected',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM api_tokens a
      WHERE token_hash IN (${protectedHashes.map((value) => `'${value}'`).join(",")}))
  )`);
  const baseline = await snapshot();
  assert(
    baseline.target && baseline.protected?.length === 2,
    "fixture session isolation inputs missing",
  );
  const wrongBinding = binding
    .map((value) =>
      value.startsWith("membership_id=")
        ? `membership_id='${otherMembership}'`
        : value,
    )
    .join(" AND ");
  const probe = await query(statement(wrongBinding));
  assert.equal(probe.matches, 0, "wrong membership matched browser token");
  assert.equal(probe.updated, 0, "wrong membership changed browser token");
  const afterProbe = await snapshot();
  assert(
    JSON.stringify(afterProbe) === JSON.stringify(baseline),
    "no-match probe changed a browser session",
  );
  const result = await query(statement(where));
  assert.equal(result.matches, 1, "exact browser session binding required");
  assert.equal(result.updated, 1, "browser idle deadline was not shortened");
  assert.equal(
    result.only_idle_changed,
    true,
    "fixture changed another session field",
  );
  for (const field of columns) {
    assert(Number.isFinite(Date.parse(result.before[field])));
    assert(Number.isFinite(Date.parse(result.after[field])));
    if (field !== "idle_expires_at")
      assert.equal(result.before[field], result.after[field]);
  }
  assert(
    Date.parse(result.after.idle_expires_at) <
      Date.parse(result.before.idle_expires_at),
  );
  assert(
    Date.parse(result.after.idle_expires_at) <
      Date.parse(result.after.expires_at),
  );
  const after = await snapshot();
  assert(
    JSON.stringify(after.protected) === JSON.stringify(baseline.protected),
    "fixture changed a protected warm browser session",
  );
  const unchanged = (value) => {
    const copy = { ...value };
    delete copy.idle_expires_at;
    return JSON.stringify(copy);
  };
  assert(
    unchanged(after.target) === unchanged(baseline.target),
    "fixture changed another target field",
  );
  assert(
    after.target.idle_expires_at === result.after.idle_expires_at,
    "actual shortened row differs from UPDATE result",
  );
  const evidence = {
    idle_ms: idleMS,
    only_idle_changed: true,
    before: result.before,
    after: result.after,
    observations: [],
    no_match_probe: { matches: 0, updated: 0, unchanged: true },
    protected_unchanged: 2,
    ...mark(),
  };
  return {
    evidence,
    async read(label) {
      const row = await query(`SELECT ${metadata("a")} || jsonb_build_object(
        'expired', a.idle_expires_at <= clock_timestamp(),
        'remaining_ms', EXTRACT(EPOCH FROM (a.idle_expires_at-clock_timestamp()))*1000
      ) FROM api_tokens a WHERE ${where}`);
      for (const field of columns)
        assert.equal(
          row[field],
          result.after[field],
          "ordinary session read renewed authority",
        );
      assert.equal(typeof row.expired, "boolean");
      assert(Number.isFinite(row.remaining_ms));
      const observation = { ...row, label, ...mark() };
      evidence.observations.push(observation);
      return observation;
    },
  };
}
