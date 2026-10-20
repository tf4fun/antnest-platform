import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvidenceFile } from "../../support/storage.mjs";
import * as implementation from "./cleanup.mjs";
import { cleanupPermissionAgents } from "./cleanup.mjs";

const id = "ed553afe-c9e0-4821-a4ef-5104e9c6301c";
function fixture(failFirst = false) {
  const effects = [];
  const cancelled = [];
  const agents = [1, 2].map((version) => ({
    agent_id: `agent-${version}`,
    name: `Permissions v${version} ${id}`,
  }));
  const api = async (path, body) => {
    if (path.startsWith("/api/admin/agents?")) {
      return path.includes("cursor=")
        ? { items: [agents[1]], next_cursor: null }
        : {
            items: [
              agents[0],
              { agent_id: "unrelated", name: "Existing Agent" },
            ],
            next_cursor: "page2",
          };
    }
    if (path.endsWith("/delete")) {
      effects.push(path);
      if (failFirst && path.includes("agent-1"))
        throw new Error("first cleanup failed");
      assert.deepEqual(body, {});
      return { request_id: path.includes("agent-1") ? "op1" : "op2" };
    }
    if (path.startsWith("/api/admin/operations/"))
      return { state: "completed" };
    return {
      ...agents.find((agent) => path.endsWith(agent.agent_id)),
      lifecycle_state: "created",
    };
  };
  return {
    api,
    effects,
    cancelled,
    cancel: async (agent) => cancelled.push(agent),
  };
}
test("independent cleanup discovers only this invocation across pages without client memory", async () => {
  const f = fixture();
  await cleanupPermissionAgents(f.api, id, f.cancel);
  assert.deepEqual(f.cancelled, ["agent-1", "agent-2"]);
  assert.equal(f.effects.length, 2);
});
test("cleanup attempts all owned Agents and fails rather than hiding partial failure", async () => {
  const f = fixture(true);
  await assert.rejects(
    cleanupPermissionAgents(f.api, id, f.cancel),
    AggregateError,
  );
  assert.equal(f.effects.length, 2);
});
test("missing ownership scope cannot trigger deletion", async () => {
  const f = fixture();
  await assert.rejects(cleanupPermissionAgents(f.api, "", f.cancel));
  assert.deepEqual(f.effects, []);
});

test("a Session cancellation failure still attempts deletion of both owned Agents and retains the original failure", async () => {
  const f = fixture();
  const original = new Error("Session cancellation failed");
  await assert.rejects(
    cleanupPermissionAgents(f.api, id, async (agent) => {
      await f.cancel(agent);
      if (agent === "agent-1") throw original;
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors[0], original);
      return true;
    },
  );
  assert.deepEqual(f.cancelled, ["agent-1", "agent-2"]);
  assert.deepEqual(f.effects, [
    "/api/admin/agents/agent-1/delete",
    "/api/admin/agents/agent-2/delete",
  ]);
});

for (const afterOperation of [false, true])
  for (const field of ["agent_id", "name"])
    test(`fresh Agent details cannot change owned ${field}${afterOperation ? " after an active operation" : ""}`, async () => {
      const f = fixture();
      let details = 0;
      const api = async (path, ...args) => {
        const result = await f.api(path, ...args);
        if (path !== "/api/admin/agents/agent-1") return result;
        details++;
        if (afterOperation && details === 1)
          return { ...result, active_operation_request_id: "create-one" };
        return { ...result, [field]: "unrelated" };
      };
      await assert.rejects(
        cleanupPermissionAgents(api, id, f.cancel),
        AggregateError,
      );
      assert.deepEqual(f.cancelled, ["agent-2"]);
      assert.deepEqual(f.effects, ["/api/admin/agents/agent-2/delete"]);
      assert.equal(details, afterOperation ? 2 : 1);
    });

test("independent cleanup failure retains both original errors when the business client uses the same evidence root", async (t) => {
  assert.equal(
    typeof implementation.preservePermissionCleanupFailure,
    "function",
  );
  const directory = await mkdtemp(
    join(tmpdir(), "antnest-permission-cleanup-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = [
    "failure.private.txt",
    "failure-inventory.private.json",
    "failure-model-status.private.json",
  ];
  for (const name of names)
    writeEvidenceFile(directory, name, `PRIVATE-BUSINESS-${name}\n`);
  const raw = ' {"errors":["PRIVATE-CLEANUP-MODEL"]}\n';
  const report = await implementation.preservePermissionCleanupFailure({
    directory,
    error: new AggregateError(
      [new Error("PRIVATE-CLEANUP-ORIGINAL")],
      "PRIVATE-CLEANUP-FAILURE",
    ),
    runID: id,
    fetchStatus: async () => new Response(raw),
  });
  assert.equal(report.status, "cleanup_failed");
  assert.equal(report.error_type, "AggregateError");
  assert(!JSON.stringify(report).includes("PRIVATE-"));
  for (const name of names) {
    assert.equal(
      await readFile(join(directory, name), "utf8"),
      `PRIVATE-BUSINESS-${name}\n`,
    );
    assert.equal(
      (await stat(join(directory, "independent-cleanup", name))).mode & 0o777,
      0o600,
    );
  }
  assert(
    (
      await readFile(join(directory, "independent-cleanup", names[0]), "utf8")
    ).includes("PRIVATE-CLEANUP-ORIGINAL"),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(directory, "independent-cleanup", names[1]), "utf8"),
    ),
    { run_id: id },
  );
  assert.equal(
    await readFile(join(directory, "independent-cleanup", names[2]), "utf8"),
    raw,
  );
  assert.equal(
    (await stat(join(directory, "independent-cleanup"))).mode & 0o777,
    0o700,
  );
});
