import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createDevelopmentWriter } from "../../support/development-configuration.mjs";
import { assertReplay } from "../../integration/agent-acp-service/support/persistence/evidence.mjs";
import { createWorkspacePrivateAccess } from "../workspace-closeout/private-access.mjs";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";

const collectTrace = (base, expected, options) =>
  collectPrivateACPConsumerTrace(base, expected, options, {
    inspect: inspectPrivateCommandTrace,
    ownedReasons: new Set(),
    inspectCompleteSources: () => {},
  });

export async function runDevelopmentReplay(
  config,
  { browser, principal, secrets, signal, decoded, files, before, counts },
  { createAccess = createWorkspacePrivateAccess } = {},
) {
  assert(config.privateAccess, "privateAccess is required");
  signal?.throwIfAborted();
  const login = { accessToken: browser?.accessToken };
  const original = structuredClone(principal);
  assert(
    typeof login.accessToken === "string" && login.accessToken,
    "original login session required",
  );
  for (const key of ["organization_id", "user_id"])
    assert(
      typeof original?.[key] === "string" && original[key],
      "original login Principal required",
    );
  assert(Array.isArray(secrets));
  assert.equal(typeof counts, "function");
  const parseCounts = (value) => {
    const rows = JSON.parse(value);
    assert(
      Array.isArray(rows) &&
        rows.length === 4 &&
        rows.every((row) => Number.isSafeInteger(row) && row >= 0),
      "four valid table counts required",
    );
    return rows;
  };
  const baseline = parseCounts(before);
  const write = createDevelopmentWriter(config, [
    "private-access.private.json",
  ]);
  const accessReport = {
    connections: [],
    authorities: [],
    closed: false,
    errors: [],
  };
  const save = () => write("private-access.private.json", accessReport);
  save();
  const errors = [];
  let access, report;
  try {
    access = await createAccess(
      { ...config, evidence: config.output },
      {
        signal,
        secrets,
        collectTrace,
        preserveConnection(index, value) {
          accessReport.connections[index - 1] = structuredClone(value);
          save();
        },
        preserveAuthority(scope, rows) {
          accessReport.authorities[scope.operation_id - 1] = {
            ...structuredClone(scope),
            receipts: structuredClone(rows),
          };
          save();
        },
      },
    );
    const client = await access.open(config.agentId, login, original);
    // The shared private connection has already initialized with the original SDK.
    const params = {
      sessionId: config.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    };
    await client.request("load", params);
    write("replay-updates.private.json", client.updates);
    const tools = client.updates.filter((u) => u.update.toolCallId);
    assert.deepEqual(
      tools.map((u) =>
        (u.update.content ?? []).filter((c) => c.type === "diff"),
      ),
      files,
      "saved file observations changed",
    );
    const normalized = structuredClone(client.updates);
    for (const u of normalized)
      if (u.update.toolCallId && u.update.content)
        u.update.content = u.update.content.filter((c) => c.type !== "diff");
    assertReplay(1, normalized, decoded, config.sessionId);
    await client.closeAndWait();
    assert.deepEqual(
      client.requests.map((row) => row.method),
      ["initialize", "session/load"],
      "expected exactly initialize and session/load",
    );
    const initialization = client.initializationRequest;
    const [load] = client.requestEvidence;
    assert.equal(client.requestEvidence.length, 1);
    for (const [row, wire] of [
      [initialization, client.requests[0]],
      [load, client.requests[1]],
    ]) {
      assert.equal(row.requestId, wire.requestId);
      assert.equal(row.method, wire.method);
      assert.equal(row.outcome, "succeeded");
      assert.equal(row.inputSessionID, wire.sessionId ?? null);
    }
    assert.equal(load.sessionId, config.sessionId);
    assert.deepEqual(load.requestParams, params);
    const after = counts();
    assert.equal(after, before, "history load created execution or history");
    const initializationTrace = await access.collect(
      { ...initialization, kind: "request" },
      [],
    );
    const trace = await access.collect({ ...load, kind: "request" }, []);
    write("replay-trace.private.json", {
      initialization: initializationTrace,
      load: trace,
    });
    report = {
      status: "business_and_topology_passed",
      session_id: config.sessionId,
      durable_messages: decoded.events.items.length,
      notifications: client.updates.length,
      history_exact: true,
      new_runs: 0,
      new_tools: 0,
      table_counts: { before: baseline, after: parseCounts(after) },
      initialization_trace: initializationTrace,
      trace,
    };
    signal?.throwIfAborted();
  } catch (error) {
    errors.push(error);
  }
  if (access)
    try {
      await access.closeAndWait();
      accessReport.closed = true;
    } catch (error) {
      errors.push(error);
    }
  accessReport.errors = [...new Set(errors)].map((error) =>
    inspect(error, { depth: 8 }),
  );
  try {
    save();
  } catch (error) {
    errors.push(error);
  }
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Development replay, evidence or cleanup failed",
    );
  write("replay-report.json", report);
  return report;
}
