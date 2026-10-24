import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { setupFoundation } from "../lifecycle-closeout/foundation-setup.mjs";
import { runtimePhysical } from "../lifecycle-closeout/recovery-support.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { assertKilled } from "../acp-restart/process.mjs";
import { withSurvivorBrowser } from "./browser.mjs";
import { createSurvivorJournal } from "./journal.mjs";

export const requiredChecks = [
  "two-original-registrations",
  "both-owners-complete-prompt",
  "original-b-run-held",
  "b-killed-without-restart",
  "original-lease-naturally-expired",
  "original-run-recovered-on-a",
  "stopped-member-publication-acknowledged",
  "same-agent-browser-prompt-completed",
  "old-prompt-not-replayed",
  "unrelated-member-denied",
  "agents-deleted",
];

async function until(read, predicate, signal, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    signal.throwIfAborted();
    const value = await read();
    if (predicate(value)) return value;
    await delay(250, undefined, { signal });
  }
  throw new Error(`${label}: deadline exceeded`);
}

function tuple(row) {
  return Object.fromEntries(
    ["registration_id", "member_id", "incarnation_id"].map((key) => [
      key,
      row[key],
    ]),
  );
}

function ownerFields(row) {
  return {
    registration_id: row.execution_owner_registration_id,
    member_id: row.execution_owner_member_id,
    incarnation_id: row.execution_owner_incarnation_id,
  };
}

function instant(raw) {
  const match =
    /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|\+00(?::00)?)$/u.exec(
      raw,
    );
  assert(match, "UTC process identity required");
  return (
    BigInt(Date.parse(match[1].replace(" ", "T") + "Z")) * 1000000n +
    BigInt((match[2] ?? "").padEnd(9, "0"))
  );
}

export async function runSurvivorBusiness(
  config,
  docker,
  signal,
  report,
  checkpoint,
) {
  const check = async (name) => {
    report.checks.push(name);
    await checkpoint();
    console.error(`ACP survivor: ${name}`);
  };
  const journal = await createSurvivorJournal(config, docker);
  const a = await journal.service("agent-acp-service");
  const b = await journal.service("agent-acp-peer-b");
  const registrations = await journal.registrations();
  assert.deepEqual(
    registrations.map((row) => row.member_id),
    ["acp-a", "acp-b"],
  );
  const [ownerA, ownerB] = registrations;
  const engine = (await docker(["info", "--format", "{{.ID}}"])).trim();
  for (const [owner, container] of [
    [ownerA, a],
    [ownerB, b],
  ]) {
    assert.equal(owner.controller_scope, config.project);
    assert.equal(owner.container_id, container.Id);
    assert.equal(owner.engine_id, engine);
    assert.equal(owner.nonce_digest_bytes, 32);
    assert.equal(instant(owner.started_at), instant(container.State.StartedAt));
    assert.equal(owner.stop_receipt_id, null);
    assert.equal(container.State.Running, true);
    const pages = await journal.history(owner.member_id);
    assert.deepEqual(
      pages.flatMap((page) => page.items.map((item) => item.registration)),
      [tuple(owner)],
    );
  }
  report.registrations = registrations;
  await check("two-original-registrations");

  const admin = new GatewayClient(config.gateway);
  const json = async (path, options) =>
    (await admin.request(path, options)).body;
  const login = await json("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  const member = {
    organization_slug: "stage3",
    email: "survivor-member@example.com",
    password: "survivor-member-password",
  };
  const owner = await json("/api/admin/directory/users", {
    body: {
      email: member.email,
      display_name: "Survivor member",
      password: member.password,
      role: "member",
    },
  });
  const { template } = await setupFoundation(admin, config.image);
  const agents = [];
  async function operation(id) {
    return until(
      () => json(`/api/admin/operations/${id}`),
      (value) => {
        assert.notEqual(
          value.state,
          "failed",
          `${value.kind}: ${value.error_code}`,
        );
        return value.state === "completed";
      },
      signal,
      "Controller operation",
    );
  }
  async function createAgent(name) {
    const created = await json("/api/admin/agents", {
      status: 202,
      body: {
        owner_user_id: owner.user.id,
        name,
        template_id: template.template_id,
        template_revision: template.revision,
      },
    });
    const id = created.agent.agent_id;
    agents.push(id);
    await operation(created.operation.request_id);
    await waitForAgentReady(() => json(`/api/admin/agents/${id}`), signal);
    const lease = await until(
      () => journal.lease(id),
      (row) => row?.live === true,
      signal,
      "Published Agent ownership",
    );
    return { id, lease, operation: created.operation.request_id };
  }
  const assigned = new Map();
  // Random platform-issued Agent IDs must produce both partitions. The bound
  // prevents an implementation that always chooses A from hanging acceptance.
  for (let attempt = 0; assigned.size < 2 && attempt < 32; attempt++) {
    const agent = await createAgent(`Survivor partition ${attempt + 1}`);
    assert(
      [ownerA.incarnation_id, ownerB.incarnation_id].includes(
        agent.lease.owner_instance_id,
      ),
    );
    if (!assigned.has(agent.lease.owner_instance_id))
      assigned.set(agent.lease.owner_instance_id, agent);
  }
  assert.equal(assigned.size, 2, "Actual Runs must exercise both ACP owners");
  const agentA = assigned.get(ownerA.incarnation_id);
  const agentB = assigned.get(ownerB.incarnation_id);
  report.agents = { a: agentA, b: agentB, created: agents };
  async function model() {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    report.model = result;
    assert.deepEqual(result.errors, []);
    return result;
  }
  async function newRun(agent, before, receipt, state) {
    return until(
      () => journal.runs(agent.id),
      (rows) => {
        const added = rows.filter(
          (row) => !before.some((old) => old.id === row.id),
        );
        assert(added.length <= 1, "One Prompt created multiple Runs");
        if (added.length !== 1 || added[0].state !== state) return false;
        assert.equal(added[0].session_id, receipt.sessionId);
        return true;
      },
      signal,
      `Original ${state} Run`,
    ).then((rows) =>
      rows.find((row) => !before.some((old) => old.id === row.id)),
    );
  }
  await withSurvivorBrowser(
    config,
    { signal, member, ownerId: owner.user.id },
    async (browser) => {
      report.browser_receipts = browser.receipts;
      const pageA = await browser.openAgent(agentA.id);
      const pageB = await browser.openAgent(agentB.id);
      for (const [agent, page, registration, phase] of [
        [agentA, pageA, ownerA, "survivor-a-before"],
        [agentB, pageB, ownerB, "survivor-b-before"],
      ]) {
        const before = await journal.runs(agent.id);
        const receipt = await browser.prompt(page, agent.id, phase);
        const run = await newRun(agent, before, receipt, "completed");
        assert.deepEqual(ownerFields(run), tuple(registration));
        report.initial_runs ??= [];
        report.initial_runs.push(run);
      }
      await check("both-owners-complete-prompt");
      const runtimeBefore = await runtimePhysical(docker, config, agentB.id);
      assert(runtimeBefore.running && runtimeBefore.healthy);
      const beforeHeld = await journal.runs(agentB.id);
      const heldReceipt = await browser.prompt(
        pageB,
        agentB.id,
        "survivor-b-held",
        { complete: false },
      );
      await until(
        model,
        (value) => value.held === "survivor-b-held",
        signal,
        "Original model request held",
      );
      const original = await newRun(agentB, beforeHeld, heldReceipt, "running");
      assert.deepEqual(ownerFields(original), tuple(ownerB));
      const originalLease = await journal.lease(agentB.id);
      assert.equal(originalLease.owner_instance_id, ownerB.incarnation_id);
      assert.equal(originalLease.epoch, original.execution_owner_epoch);
      assert.equal(originalLease.live, true);
      report.original_run = original;
      report.original_lease = originalLease;
      await check("original-b-run-held");

      await docker(["kill", "--signal", "KILL", b.Id]);
      assert.equal((await docker(["wait", b.Id])).trim(), "137");
      const killed = await journal.service("agent-acp-peer-b");
      assertKilled(b, killed);
      assert.equal(killed.State.Running, false);
      report.killed = {
        id: killed.Id,
        exit_code: killed.State.ExitCode,
        restarts: killed.RestartCount,
      };
      await check("b-killed-without-restart");
      // Capture the last renewal after process exit. Never mutate SQL, release
      // the lease, restart B, synthesize a stop receipt or call recovery directly.
      const deadLease = await journal.lease(agentB.id);
      assert.equal(deadLease.owner_instance_id, ownerB.incarnation_id);
      assert.equal(deadLease.epoch, originalLease.epoch);
      report.dead_lease = deadLease;
      await until(
        () => journal.clockAfter(deadLease.expires_at),
        Boolean,
        signal,
        "Natural database lease expiry",
      );
      await check("original-lease-naturally-expired");
      const recovered = await until(
        () => journal.runs(agentB.id),
        (rows) =>
          rows.find((row) => row.id === original.id)?.executor_state ===
          "quiescent",
        signal,
        "Survivor original Run recovery",
      );
      const old = recovered.find((row) => row.id === original.id);
      assert.deepEqual(ownerFields(old), tuple(ownerB));
      assert.equal(old.execution_owner_epoch, original.execution_owner_epoch);
      assert.equal(old.state, "failed");
      assert.equal(old.terminal_class, "failed");
      assert.equal(old.tool_effect_state, "none");
      assert.equal(old.error_class, "service_restarted_during_run");
      assert.deepEqual(
        recovered.filter((row) => row.id !== old.id),
        beforeHeld,
      );
      const activeLease = await journal.lease(agentB.id);
      assert.equal(activeLease.owner_instance_id, ownerA.incarnation_id);
      assert.equal(BigInt(activeLease.epoch), BigInt(originalLease.epoch) + 1n);
      assert.equal(activeLease.live, true);
      const { status, body: inspection } = await journal.rcInspect(
        ownerB.registration_id,
      );
      assert.equal(status, 200);
      assert.equal(inspection.state, "stopped");
      for (const [key, value] of Object.entries(tuple(ownerB)))
        assert.equal(inspection[key], value);
      const audit = await journal.recoveries(original.id);
      assert.deepEqual(audit, [
        {
          run_id: original.id,
          receipt_id: inspection.stop_receipt.receipt_id,
          organization_id: login.principal.organization_id,
          agent_id: agentB.id,
          original_registration_id: ownerB.registration_id,
          original_member_id: ownerB.member_id,
          original_incarnation_id: ownerB.incarnation_id,
          original_epoch: original.execution_owner_epoch,
          recovering_registration_id: ownerA.registration_id,
          recovering_member_id: ownerA.member_id,
          recovering_incarnation_id: ownerA.incarnation_id,
          recovering_epoch: activeLease.epoch,
        },
      ]);
      assert.deepEqual(await journal.stopReceipts(ownerB.registration_id), [
        {
          receipt_id: inspection.stop_receipt.receipt_id,
          registration_id: ownerB.registration_id,
          inspection,
        },
      ]);
      assert.deepEqual(
        await runtimePhysical(docker, config, agentB.id),
        runtimeBefore,
      );
      const healthy = await journal.lease(agentA.id);
      assert.equal(healthy.owner_instance_id, ownerA.incarnation_id);
      assert.equal(healthy.epoch, agentA.lease.epoch);
      assert.equal(healthy.live, true);
      report.recovery = {
        run: old,
        lease: activeLease,
        inspection,
        audit,
        runtime: runtimeBefore,
      };
      await check("original-run-recovered-on-a");

      const published = await createAgent(
        "Survivor publication after B stopped",
      );
      assert.equal(published.lease.owner_instance_id, ownerA.incarnation_id);
      report.post_failure_publication = published;
      await check("stopped-member-publication-acknowledged");
      await browser.closePage(pageB);
      const recoveredPage = await browser.openAgent(agentB.id);
      const beforePost = await journal.runs(agentB.id);
      const receipt = await browser.prompt(
        recoveredPage,
        agentB.id,
        "survivor-b-after",
      );
      const post = await newRun(agentB, beforePost, receipt, "completed");
      assert.deepEqual(ownerFields(post), tuple(ownerA));
      assert.equal(post.execution_owner_epoch, activeLease.epoch);
      report.recovered_browser_run = post;
      await check("same-agent-browser-prompt-completed");
      const inventory = await model();
      assert.equal(inventory.held, null);
      assert.deepEqual(
        inventory.requests.map((request) => request.phase),
        [
          "survivor-a-before",
          "survivor-b-before",
          "survivor-b-held",
          "survivor-b-after",
        ],
      );
      assert.deepEqual(
        (await journal.runs(agentB.id)).filter((row) => row.id !== post.id),
        beforePost,
      );
      const stillKilled = await journal.service("agent-acp-peer-b");
      assertKilled(b, stillKilled);
      assert.deepEqual(
        tuple(
          (await journal.registrations()).find(
            (row) => row.member_id === "acp-b",
          ),
        ),
        tuple(ownerB),
      );
      await check("old-prompt-not-replayed");
    },
  );

  const foreign = {
    organization_slug: "stage3",
    email: "survivor-foreign@example.com",
    password: "survivor-foreign-password",
  };
  await json("/api/admin/directory/users", {
    body: {
      email: foreign.email,
      display_name: "Unrelated member",
      password: foreign.password,
      role: "member",
    },
  });
  const outsider = new GatewayClient(config.gateway);
  await outsider.request("/api/session/login", { body: foreign });
  const beforeDeniedRuns = await journal.runs(agentB.id);
  const beforeDeniedModel = await model();
  await outsider.request(
    `/api/app/workspace/v1/agents/${encodeURIComponent(agentB.id)}/view`,
    { status: 403 },
  );
  assert.deepEqual(await journal.runs(agentB.id), beforeDeniedRuns);
  assert.deepEqual(await model(), beforeDeniedModel);
  await check("unrelated-member-denied");
  for (const id of agents) {
    const deleted = await json(`/api/admin/agents/${id}/delete`, {
      status: 202,
      body: {},
    });
    await operation((deleted.operation ?? deleted).request_id);
    await until(
      () => runtimePhysical(docker, config, id),
      (value) => value.ids?.length === 0 && value.volumes.length === 0,
      signal,
      "Deleted Agent Runtime resources",
    );
  }
  const finalModel = await model();
  assert.equal(finalModel.held, null);
  assert.deepEqual(
    finalModel.requests.map((request) => request.phase),
    [
      "survivor-a-before",
      "survivor-b-before",
      "survivor-b-held",
      "survivor-b-after",
    ],
  );
  await check("agents-deleted");
  assert.deepEqual(report.checks, requiredChecks);
  report.business_completed = true;
  await checkpoint();
}
