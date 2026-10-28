import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { createAccessCatalog } from "../identity-closeout/catalog.mjs";
import { serviceClient } from "../../support/service-grants.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";
import { openStage3Connection } from "../stage3-base/connection.mjs";
import { withPrivateCommandResources } from "../acp-commands/connection.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import { readinessProof, publicationProof } from "./readiness-proof.mjs";
import { snapshotSession, resumeSession } from "./browser-session.mjs";
import { phaseTiming } from "./timing.mjs";

const directory = "/tmp/agent-readiness";
const save = (name, value) =>
  writeEvidenceFile(directory, name, JSON.stringify(value, null, 2) + "\n");
const load = (name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
const loadSessions = () =>
  JSON.parse(readFileSync("/tmp/agent-readiness-session.private.json", "utf8"));
const account = {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
const memberAccount = {
  organization_slug: "stage3",
  email: "readiness-owner@example.com",
  password: "readiness-owner-password",
};
const admin = new GatewayClient("http://edge-gateway:8080"),
  member = new GatewayClient("http://edge-gateway:8080");
const service = serviceClient(),
  owner = new AbortController(),
  signal = owner.signal;
const interrupt = () =>
  owner.abort(new Error("readiness client interrupted or timed out"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 180000);
const api = async (path, options) => {
  signal.throwIfAborted();
  return (await admin.request(path, options)).body;
};
async function json(url) {
  signal.throwIfAborted();
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
  });
  assert.equal(response.status, 200);
  return response.json();
}
const proxy = () => json("http://publication-delay-proxy:8080/status");
const model = () => json("http://readiness-model-peer:8080/status");
async function poll(read, accept, timing, phase) {
  while (true) {
    signal.throwIfAborted();
    const value = timing
      ? await timing.measure(`${phase}Request`, read, "polls")
      : await read();
    if (accept(value)) return value;
    const sleep = () => delay(100, undefined, { signal });
    if (timing) await timing.measure(`${phase}Sleep`, sleep, "polls");
    else await sleep();
  }
}
async function seed() {
  const login = await api("/api/session/login", { body: account });
  const created = await api("/api/admin/directory/users", {
    body: {
      email: memberAccount.email,
      display_name: "Readiness owner",
      password: memberAccount.password,
      role: "member",
    },
  });
  const ownerLogin = (
    await member.request("/api/session/login", { body: memberAccount })
  ).body;
  assert.equal(ownerLogin.principal.user_id, created.user.id);
  assert.equal(
    ownerLogin.principal.organization_id,
    login.principal.organization_id,
  );
  const catalog = await createAccessCatalog(admin, {
    name: "Acknowledged readiness",
    baseURL: "http://readiness-model-peer:8080/v1",
    modelName: "stage3-model",
    credential: "stage3-model-secret",
    systemPrompt: "Reply briefly to the original message without using tools.",
    maxModelRequests: 1,
    runtimeImage: process.env.TEST_RUNTIME_IMAGE,
  });
  save("context.json", {
    principal: ownerLogin.principal,
    template: catalog.template,
  });
  writeEvidenceFile(
    "/tmp",
    "agent-readiness-session.private.json",
    JSON.stringify({
      admin: snapshotSession(admin, login.principal),
      member: snapshotSession(member, ownerLogin.principal),
    }) + "\n",
  );
  assert.equal((await proxy()).delayMs, 2000);
  assert.deepEqual((await model()).requests, []);
}
async function round(index) {
  const timing = phaseTiming();
  const context = load("context.json"),
    sessions = loadSessions(),
    phase = `readiness-${index}`;
  const row = {
    index,
    phase,
    principalId: context.principal.user_id,
    organizationId: context.principal.organization_id,
    actions: [],
    timing: { round: timing.values },
  };
  const preserve = () => save(`round-${index}.json`, row);
  const mark = (name) => row.actions.push({ name, at: performance.now() });
  const clients = new Set(),
    telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
  try {
    await withPrivateCommandResources(
      clients,
      telemetry,
      async () => {
        const principal = await timing.measure("sessions", async () => {
          await resumeSession(admin, sessions.admin);
          return resumeSession(member, sessions.member);
        });
        assert.equal(principal.user_id, row.principalId);
        const created = await timing.measure("create", () =>
          api("/api/admin/agents", {
            status: 202,
            headers: { "Idempotency-Key": randomUUID() },
            body: {
              owner_user_id: row.principalId,
              name: phase,
              template_id: context.template.template_id,
              template_revision: context.template.revision,
            },
          }),
        );
        row.agentId = created.agent.agent_id;
        row.operationId = created.operation.request_id;
        preserve();
        const { context: caller } = await timing.measure("readyContext", () =>
          service.sessionContext(admin.accessToken, row.agentId),
        );
        const raw = (suffix) =>
          service.json(
            `http://agent-controller:8080/internal/agents/${encodeURIComponent(row.agentId)}${suffix}`,
            "console-controller",
            { method: "GET", context: caller, signal },
          );
        const agent = () =>
          raw(`?organization_id=${encodeURIComponent(row.organizationId)}`);
        const events = async () => {
          const page = await raw(
            `/events?organization_id=${encodeURIComponent(row.organizationId)}&after_sequence=0&limit=100`,
          );
          assert(page.events.length < 100, "readiness event page truncated");
          return page.events;
        };
        // Only Controller's raw v2 event opens admission. No ACP-ready polling,
        // catalog wait, sleeping after ready, or Prompt retry is allowed here.
        await timing.measure("ready", async () => {
          const observe = (read) =>
            timing.measure("readyRequest", read, "polls");
          while (true) {
            signal.throwIfAborted();
            row.events = await observe(events);
            if (
              row.events.some((event) => event.event_type === "agent_ready")
            ) {
              readinessProof(row.events, row);
              mark("ready_observed");
              break;
            }
            if (!row.delayed) {
              const status = await observe(proxy);
              const before = status.attempts.find(
                (attempt) =>
                  attempt.organizationId === row.organizationId &&
                  attempt.delayStartedAt !== null &&
                  attempt.forwardedAt === null &&
                  attempt.bindings.some(
                    (binding) =>
                      binding.agent_id === row.agentId &&
                      binding.accepting_runs === true &&
                      binding.runtime_revision,
                  ),
              );
              if (before) {
                const current = await observe(agent),
                  during = await observe(events);
                const after = (await observe(proxy)).attempts.find(
                  (attempt) => attempt.id === before.id,
                );
                if (after?.forwardedAt === null) {
                  assert.equal(current.readiness, "preparing");
                  assert(
                    !during.some((event) => event.event_type === "agent_ready"),
                  );
                  row.delayed = {
                    before,
                    after,
                    agent: current,
                    events: during,
                  };
                  preserve();
                }
              }
            }
            await timing.measure(
              "readySleep",
              () => delay(50, undefined, { signal }),
              "polls",
            );
          }
        });
        mark("initialize_started");
        const connection = await timing.measure("initialize", () =>
          openStage3Connection(
            { name: phase, version: 1 },
            row.agentId,
            member,
            {
              principal,
              telemetry,
              service,
              secrets: [
                account.password,
                memberAccount.password,
                "stage3-model-secret",
                ...admin.cookies.values(),
                ...member.cookies.values(),
              ],
              signal,
              preserve(snapshot) {
                row.connection = snapshot;
                preserve();
              },
            },
          ),
        );
        clients.add(connection);
        mark("new_started");
        const session = await timing.measure("session", () =>
          connection.request("new", {
            cwd: "/workspace",
            mcpServers: [],
          }),
        );
        mark("prompt_started");
        const result = await timing.measure("prompt", () =>
          connection.request(
            "prompt",
            {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: phase }],
            },
            120000,
          ),
        );
        assert.equal(result.stopReason, "end_turn");
        await timing.measure("evidence", async () => {
          await connection.closeAndWait();
          clients.delete(connection);
          row.currentAgent = await agent();
          row.events = await events();
          const proof = readinessProof(row.events, row);
          const attempts = (await proxy()).attempts;
          row.publication = attempts.find(
            (attempt) => attempt.id === row.delayed?.before.id,
          );
          publicationProof(row.publication, proof, row);
          row.runList = await poll(
            () =>
              api(
                `/api/admin/execution-audits?agent_id=${row.agentId}&limit=100`,
              ),
            (page) => page.items.length > 0,
            timing,
            "audit",
          );
          assert.equal(row.runList.items.length, 1);
          row.run = await poll(
            () =>
              api(`/api/admin/execution-audits/${row.runList.items[0].run_id}`),
            (run) =>
              run.state === "completed" && run.executor_state === "quiescent",
            timing,
            "audit",
          );
          row.model = await model();
          row.status = "prompt_passed";
        });
      },
      { directory },
    );
  } catch (error) {
    row.status = "failed";
    row.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    timing.finish();
    preserve();
  }
}
async function remove(index) {
  const timing = phaseTiming();
  const row = load(`round-${index}.json`);
  row.timing ??= {};
  row.timing.deletion = timing.values;
  assert(row.agentId);
  try {
    await timing.measure("sessions", () =>
      resumeSession(admin, loadSessions().admin),
    );
    const accepted = await timing.measure("deleteRequest", () =>
      api(`/api/admin/agents/${row.agentId}/delete`, {
        status: 202,
        body: {},
        headers: { "Idempotency-Key": randomUUID() },
      }),
    );
    const operation = await timing.measure("deleteWait", () =>
      poll(
        () =>
          api(
            `/api/admin/operations/${accepted.request_id ?? accepted.operation?.request_id}`,
          ),
        (operation) => {
          assert(
            ["running", "completed"].includes(operation.state),
            "delete operation failed",
          );
          return operation.state === "completed";
        },
        timing,
        "delete",
      ),
    );
    row.deleted = {
      operation,
      agent: await timing.measure("evidence", () =>
        api(`/api/admin/agents/${row.agentId}`),
      ),
    };
  } finally {
    timing.finish();
    save(`round-${index}.json`, row);
  }
}

const [command, value] = process.argv.slice(2),
  index = Number(value);
try {
  if (command === "seed") await seed();
  else {
    assert(Number.isSafeInteger(index) && index >= 1 && index <= 100);
    if (command === "round") await round(index);
    else if (command === "delete") await remove(index);
    else assert.fail("unknown readiness client command");
  }
} catch (error) {
  save("command-failure.private.json", {
    command,
    index: Number.isSafeInteger(index) ? index : null,
    ...summarizeFailure(error),
  });
  // Full details stay in private files; fixture passwords never enter CI logs.
  console.error("Agent readiness client failed:", error.name);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
