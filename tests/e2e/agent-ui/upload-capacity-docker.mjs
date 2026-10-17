import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { member, setup } from "../workspace-closeout/c4-setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { buildPromptBlocks } from "../../../services/agent-ui/web/src/lib/prompt.ts";
import { acpPromptRequestBytes } from "../../../services/agent-ui/web/server/src/adapters/acp-http.ts";
import { observeWorkspaceStream } from "../edge-gateway/resolve-cache-stream.mjs";
import {
  createCacheRuntimeWork,
  pollOutageObservation as poll,
} from "../edge-gateway/resolve-cache-runtime-work.mjs";
import { joinedRuntimeExec } from "../edge-gateway/resolve-cache-runtime-exec.mjs";
import { createOutageRunSnapshotReader } from "../edge-gateway/resolve-cache-run-snapshot.mjs";
import { groupAlive } from "../workspace-closeout/process.mjs";
import { cacheRuntimeFiles } from "../workspace-closeout/cache-runtime-work.mjs";
import {
  capacityCases,
  capacityImages,
  capacityContextWindow,
} from "./upload-capacity-workload.mjs";
import { startHeldUpload } from "./upload-capacity-client.mjs";
import { inspectCapacityCase } from "./upload-capacity-evidence.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const stamp = () => process.hrtime.bigint().toString();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const base = (agent) =>
  "/api/app/workspace/v1/agents/" + encodeURIComponent(agent);
const ownerLabel = "io.antnest.verification.project";

export async function runCapacity() {
  process.chdir(root);
  process.umask(0o077);
  const abort = new AbortController(),
    signal = abort.signal;
  const interrupt = () =>
    abort.abort(new Error("capacity integration interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 900000);
  let config, before, output, failure;
  const candidates = [],
    streams = [],
    uploads = [],
    problems = [],
    cases = [],
    requests = [];
  const evidence = {
    captured_at: new Date().toISOString(),
    client_pid: process.pid,
    cases,
    requests,
    checks: [],
    scope:
      "real Gateway/UI/ACP/Runtime capacity; deterministic external model only",
  };
  const save = (name, value) =>
    writeEvidenceFile(
      output,
      name,
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value, null, 2) + "\n",
    );
  const attempt = async (action) => {
    try {
      return await action();
    } catch (error) {
      problems.push(error);
    }
  };
  const closeStream = async (ref) => {
    if (ref.joined) return;
    const closure = await ref.stream.closeAndWait();
    ref.closed_ns = stamp();
    ref.joined = true;
    ref.raw = { ...ref.stream.evidence, closure };
  };
  const http = async (client, path, options = {}) => {
    const record = {
      path,
      sent_ns: stamp(),
      sent_perf_ms: performance.now(),
      cookie_sha256: hash(client.cookie),
    };
    requests.push(record);
    if (options.body !== undefined) record.request = options.body;
    const result = await client.request(path, options);
    Object.assign(record, {
      status: result.status,
      response: result.body,
      trace_id: result.traceID,
      response_trace_id: result.headers.get("x-antnest-trace-id"),
      complete_ns: stamp(),
      complete_perf_ms: performance.now(),
    });
    return record;
  };
  try {
    const initialDocker = dockerClient(process.env, signal);
    const refs = (
      await initialDocker([
        "image",
        "ls",
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ])
    )
      .split("\n")
      .filter((v) => v && !v.includes("<none>"));
    before = await snapshotEnvironment({ images: refs, signal });
    config = await configuration(signal);
    output =
      root +
      "artifacts/verification/agent-ui-upload-capacity-" +
      config.project.slice(-8);
    save("environment-before.json", before);
    evidence.project = config.project;
    const docker = dockerClient(config.env, signal, 900000);
    Object.assign(config.env, {
      ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
      ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
        config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
      ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
        config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(
          ".0/24",
          ".128/25",
        ),
    });
    const specs = [
      ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
      ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
      ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
    ];
    const expectedImages = {};
    for (const [name, variable] of specs) {
      const tag = "antnest/" + name + ":capacity-" + config.project.slice(-8);
      assert.equal(
        await docker(["image", "ls", "-q", "--filter", "reference=" + tag]),
        "",
      );
      candidates.push(tag);
      config.env[variable] = tag;
      const [, ...command] = candidateCommand({
        name,
        tag,
        labels: { [ownerLabel]: config.project },
        build: [
          "docker",
          "build",
          "-f",
          "services/" + name + "/Dockerfile",
          "--label",
          ownerLabel + "=" + config.project,
          "-t",
          tag,
          ".",
        ],
      });
      console.log(JSON.stringify({ phase: "build", service: name }));
      save(
        "build-" + name + ".log",
        await docker(command, true, {
          env: candidateEnvironment(config.env),
          captureStderr: true,
        }),
      );
      expectedImages[name] = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        tag,
      ]);
    }
    const compose = (args) =>
      composeArgs(config.project, [
        "-f",
        "tests/e2e/workspace-closeout/c4.compose.yaml",
        "-f",
        "tests/e2e/agent-ui/upload-capacity.compose.yaml",
        ...args,
      ]);
    console.log(JSON.stringify({ phase: "start" }));
    await docker(
      compose(["up", "-d", "--wait", "--wait-timeout", "180", "--no-build"]),
      true,
    );
    const ids = (await docker(compose(["ps", "-q"])))
      .split("\n")
      .filter(Boolean);
    const format =
      '{"id":{{json .Id}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"image":{{json .Image}},"started_at":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"running":{{json .State.Running}}}';
    evidence.deployment = (
      await docker(["inspect", "--format", format, ...ids])
    )
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const [name, image] of Object.entries(expectedImages)) {
      const rows = evidence.deployment.filter((row) => row.service === name);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].image, image);
      assert.equal(rows[0].running, true);
    }
    save("deployment.json", evidence.deployment);
    const fixture = await setup(config, signal, {
      contextWindow: capacityContextWindow,
    });
    evidence.model_profiles = (
      await fixture.json("/api/admin/model-profiles")
    ).items;
    assert.equal(evidence.model_profiles.length, 1);
    assert.equal(
      evidence.model_profiles[0].model.context_window,
      capacityContextWindow,
    );
    const bLogin = {
      organization_slug: "stage3",
      email: "capacity-b@example.com",
      password: "capacity-b-password",
    };
    await fixture.json("/api/admin/directory/users", {
      body: {
        email: bLogin.email,
        display_name: "Capacity user B",
        password: bLogin.password,
        role: "member",
      },
    });
    const clientA = new GatewayClient(config.gateway),
      clientB = new GatewayClient(config.gateway);
    const principalA = (
      await clientA.request("/api/session/login", { body: member })
    ).body.principal;
    const principalB = (
      await clientB.request("/api/session/login", { body: bLogin })
    ).body.principal;
    assert.notEqual(principalA.user_id, principalB.user_id);
    assert.equal(principalA.organization_id, principalB.organization_id);
    evidence.principals = [principalA, principalB];
    const owners = [
      { client: clientA, principal: principalA, agent: await fixture.ready() },
    ];
    const createOwner = async (principal, client, name) => {
      const created = await fixture.json("/api/admin/agents", {
        status: 202,
        body: {
          owner_user_id: principal.user_id,
          name,
          template_id: fixture.template.template_id,
          template_revision: fixture.template.revision,
        },
      });
      await fixture.operation(created.operation.request_id);
      const agent = await waitForAgentReady(
        () => fixture.json("/api/admin/agents/" + created.agent.agent_id),
        signal,
      );
      return { principal, client, agent };
    };
    for (const [principal, client, name] of [
      [principalB, clientB, "B primary"],
      [principalA, clientA, "A filler"],
      [principalB, clientB, "B filler"],
    ])
      owners.push(await createOwner(principal, client, name));
    evidence.agents = owners.map((owner) => owner.agent);
    const session = async (owner) => {
      for (const key of ["session_id", "aux_session_id"])
        owner[key] = (
          await owner.client.request(base(owner.agent.agent_id) + "/sessions", {
            status: 201,
            body: {},
          })
        ).body.sessionId;
      assert.notEqual(owner.session_id, owner.aux_session_id);
    };
    const openOwner = async (owner) => {
      owner.streams = [];
      for (let index = 0; index < 16; index++) {
        const selectedSession =
          index < 8 ? owner.session_id : owner.aux_session_id;
        const stream = await observeWorkspaceStream(
          owner.client,
          owner.agent.agent_id,
          selectedSession,
          signal,
          { credentialScope: (cookie) => ({ sha256: hash(cookie) }) },
        );
        const ref = {
          stream,
          organization_id: owner.principal.organization_id,
          principal_id: owner.principal.user_id,
          agent_id: owner.agent.agent_id,
          session_id: selectedSession,
        };
        streams.push(ref);
        owner.streams.push(ref);
        const first = await stream.wait(
          (view) =>
            view.selectedSessionId === selectedSession &&
            view.availability === "ready",
        );
        Object.assign(ref, {
          view: first.view,
          ready_ns: stamp(),
          ready_at_ms: first.at,
          status: stream.evidence.status,
          trace_id: stream.evidence.trace_id,
          response_trace_id: stream.evidence.trace_id,
        });
        stream.assertOpen();
      }
    };
    for (const owner of owners) {
      await session(owner);
      await openOwner(owner);
    }
    const images = capacityImages();
    images.forEach((image, index) =>
      save("attachment-" + index + ".png", image.bytes),
    );
    const attachments = images.map((image, index) => ({
      id: String(index),
      name: "capacity-" + index + ".png",
      file: new File([image.bytes], "capacity-" + index + ".png", {
        type: "image/png",
      }),
    }));
    const model = async () => {
      const response = await fetch(config.model + "/status", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.errors, []);
      return body;
    };
    for (const [index, spec] of capacityCases.entries()) {
      if (index) {
        // Each case starts independent streams within the production lifetime.
        // Unknown Bash side effects remain unresolved on their original Agent;
        // a fresh B Agent avoids claiming that the earlier operation recovered.
        for (const owner of owners)
          for (const ref of owner.streams) await closeStream(ref);
        owners[1] = await createOwner(
          principalB,
          clientB,
          "B primary " + index,
        );
        evidence.agents.push(owners[1].agent);
        for (const owner of owners.slice(0, 2)) await session(owner);
        for (const owner of owners) await openOwner(owner);
      }
      const [a, b] = owners;
      const aBase = base(a.agent.agent_id),
        bBase = base(b.agent.agent_id),
        aSession = aBase + "/sessions/" + a.session_id,
        bSession = bBase + "/sessions/" + b.session_id;
      const record = {
        ...spec,
        scope: {
          organization_id: principalA.organization_id,
          user_a: principalA.user_id,
          user_b: principalB.user_id,
          agent_a: a.agent.agent_id,
          agent_b: b.agent.agent_id,
          session_a: a.session_id,
          session_b: b.session_id,
          session_a_aux: a.aux_session_id,
          session_b_aux: b.aux_session_id,
        },
        calibration: { before: [], after: [] },
      };
      cases.push(record);
      console.log(JSON.stringify({ phase: "case", case: spec.id }));
      const aView = (
        await http(clientA, aBase + "/view?sessionId=" + a.session_id)
      ).response;
      const prompt = await buildPromptBlocks(
        spec.id + "-upload",
        attachments,
        aView.promptCapabilities,
      );
      const intentId = spec.id + "-upload";
      const payload = {
        intentId,
        expectedAppendVersion: aView.selectedView.appendVersion,
        prompt,
      };
      const body = Buffer.from(JSON.stringify(payload));
      const wire = acpPromptRequestBytes({
        ...payload,
        sessionId: a.session_id,
      });
      assert(wire >= 16 * 1024 * 1024 * 0.99 && wire <= 16 * 1024 * 1024);
      const work = await createCacheRuntimeWork({
        docker,
        config,
        agent: b.agent,
        principal: principalB,
        readerPrincipal: principalB,
        signal,
      });
      record.runtime = work.evidence;
      await work.assertFresh();
      const observe = async (requestSignal = signal) => {
        const value = await work.observe({ signal: requestSignal });
        value.at_ns = stamp();
        value.at_perf_ms = performance.now();
        return value;
      };
      const bView = (
        await http(clientB, bBase + "/view?sessionId=" + b.session_id)
      ).response.selectedView;
      const heldID = spec.id + "-held";
      record.held_prompt = await http(clientB, bSession + "/prompts", {
        status: 202,
        headers: { "Idempotency-Key": heldID, "If-Match": bView.historyToken },
        body: {
          intentId: heldID,
          expectedAppendVersion: bView.appendVersion,
          prompt: [{ type: "text", text: heldID }],
        },
      });
      const held = await b.streams[0].stream.wait((view) =>
        view.operations.some(
          (o) =>
            o.operationId === heldID &&
            o.acceptance === "acp" &&
            ["accepted", "running"].includes(o.phase),
        ),
      );
      record.accepted = held.view.operations.find(
        (o) => o.operationId === heldID,
      );
      work.evidence.started = await poll(
        async (samplingSignal) => {
          const v = await observe(samplingSignal);
          return (
            v.work.pid &&
            v.work.pgid &&
            v.work.effects === "started\n" &&
            groupAlive(v.work.processes, v.work.pgid) &&
            v
          );
        },
        "real held Bash group",
        signal,
      );
      const snapshot = await createOutageRunSnapshotReader({
        project: config.project,
        compose,
        docker,
        signal,
        scope: {
          run_id: record.accepted.runId,
          session_id: b.session_id,
          organization_id: principalB.organization_id,
          agent_id: b.agent.agent_id,
          principal_id: principalB.user_id,
          bridge_intent_id: heldID,
          execution_revision: work.evidence.execution_revision,
          runtime_revision: work.evidence.runtime_revision,
          runtime_execution_id: work.evidence.runtime_execution_id,
        },
      });
      record.run_snapshot = (await snapshot.read("before-running")).record;
      record.run_storage = snapshot.evidence;
      record.scope_rejection = await http(
        clientA,
        bBase + "/view?sessionId=" + b.session_id,
        { status: 403 },
      );
      record.wrong_run = await http(
        clientB,
        bSession + "/operations/" + heldID + "/cancel",
        { status: 409, body: { expectedRunId: "wrong-run" } },
      );
      for (let n = 0; n < 4; n++)
        record.calibration.before.push(
          await http(clientB, bBase + "/view?sessionId=" + b.session_id),
        );
      const active = owners.flatMap((owner) => owner.streams);
      assert.equal(active.length, 64);
      record.pool = active.map((ref) => {
        ref.stream.assertOpen();
        return {
          organization_id: ref.organization_id,
          principal_id: ref.principal_id,
          agent_id: ref.agent_id,
          session_id: ref.session_id,
          trace_id: ref.trace_id,
          response_trace_id: ref.trace_id,
          status: ref.status,
          view: ref.view,
          ready_ns: ref.ready_ns,
          ready_at_ms: ref.ready_at_ms,
          live_before_ns: stamp(),
        };
      });
      record.overflow = await http(
        clientA,
        aBase + "/events?sessionId=" + a.session_id,
        { status: 503, timeoutMs: 2000 },
      );
      record.overflow.body = record.overflow.response;
      const upload = startHeldUpload(
        config.gateway + aSession + "/prompts",
        {
          Cookie: clientA.cookie,
          Origin: config.gateway,
          "X-Antnest-CSRF-Token": clientA.csrf,
          "Idempotency-Key": intentId,
          "If-Match": aView.selectedView.historyToken,
        },
        body,
        signal,
      );
      uploads.push(upload);
      record.upload = Object.assign(upload.evidence, {
        path: aSession + "/prompts",
        intent_id: intentId,
        wire_bytes: wire,
        limit: 16 * 1024 * 1024,
        body_sha256: hash(body),
        capabilities: aView.promptCapabilities,
        attachments: images.map(({ sha256, bytes, width, height }) => ({
          sha256,
          size: bytes.length,
          width,
          height,
        })),
      });
      await upload.flushed;
      // Client pacing gives the actual receiver time to consume the held prefix.
      // Acceptance still requires exported native phase overlap; there is no
      // server/parser delay and no retry-until-overlap loop.
      await delay(100, undefined, { signal });
      work.evidence.before_cancel = await observe();
      assert(
        groupAlive(
          work.evidence.before_cancel.work.processes,
          work.evidence.started.work.pgid,
        ),
      );
      if (spec.phase === "body-completion-and-parse") {
        await upload.finish();
        // Leave room for the measured client/server clock uncertainty after EOF.
        // The original native events must still prove the complete overlap.
        await delay(20, undefined, { signal });
      }
      const cancelPath =
        spec.cancel_path === "operation-cancel"
          ? bSession + "/operations/" + heldID + "/cancel"
          : bBase + "/commands";
      const cancelBody =
        spec.cancel_path === "operation-cancel"
          ? { expectedRunId: record.accepted.runId }
          : {
              text: "/stop",
              sessionId: b.session_id,
              operationId: heldID,
              expectedRunId: record.accepted.runId,
            };
      record.cancel = await http(clientB, cancelPath, { body: cancelBody });
      work.evidence.quiescent = await poll(
        async (samplingSignal) => {
          const v = await observe(samplingSignal);
          return (
            !groupAlive(v.work.processes, work.evidence.started.work.pgid) && v
          );
        },
        "original Runtime work stopped",
        signal,
        5000,
        10,
      );
      const terminal = await b.streams[0].stream.wait((view) =>
        view.operations.some(
          (o) =>
            o.operationId === heldID &&
            o.runId === record.accepted.runId &&
            o.phase === "uncertain" &&
            o.errorClass === "cancelled_tool_outcome_unknown",
        ),
      );
      record.terminal = {
        operation: terminal.view.operations.find(
          (o) => o.operationId === heldID,
        ),
        at_ns: stamp(),
        at_perf_ms: performance.now(),
        source_at_perf_ms: terminal.at,
        source_trace_id: b.streams[0].trace_id,
      };
      for (const pool of record.pool) {
        const ref = active.find((s) => s.trace_id === pool.trace_id);
        ref.stream.assertOpen();
        pool.live_after_ns = stamp();
        pool.live_after_ms = performance.now();
      }
      record.measured_ms = Math.max(
        ...[
          record.cancel.complete_ns,
          record.terminal.at_ns,
          work.evidence.quiescent.at_ns,
        ].map(
          (value) =>
            Number(BigInt(value) - BigInt(record.cancel.sent_ns)) / 1e6,
        ),
      );
      // Finish held input even if the strict timing admission fails; then preserve
      // all observations and evaluate the unchanged deadline in the final oracle.
      if (spec.phase === "body-incomplete") await upload.finish();
      await upload.response;
      await upload.closeAndWait();
      assert.equal(record.upload.status, 202);
      const completed = await a.streams[0].stream.wait(
        (view) =>
          view.operations.some(
            (o) =>
              o.operationId === intentId &&
              ["completed", "failed", "cancelled", "uncertain"].includes(
                o.phase,
              ),
          ),
        { timeoutMS: 60000 },
      );
      record.upload_terminal = completed.view.operations.find(
        (o) => o.operationId === intentId,
      );
      assert.equal(
        record.upload_terminal.phase,
        "completed",
        "uploaded Run ended with " + record.upload_terminal.errorClass,
      );
      record.upload_audit = await fixture.json(
        "/api/admin/execution-audits/" + record.upload_terminal.runId,
      );
      record.audit = await fixture.json(
        "/api/admin/execution-audits/" + record.accepted.runId,
      );
      const observedModel = await model();
      const heldRows = observedModel.requests.filter(
          (row) => row.phase === heldID,
        ),
        uploadRows = observedModel.requests.filter(
          (row) => row.phase === intentId,
        );
      assert.equal(heldRows.length, 1);
      assert.equal(uploadRows.length, 1);
      record.held_model = {
        ...heldRows[0],
        continuations: heldRows.filter((row) => row.stage !== "tool").length,
      };
      record.upload_model = uploadRows[0];
      for (let n = 0; n < 4; n++)
        record.calibration.after.push(
          await http(clientB, bBase + "/view?sessionId=" + b.session_id),
        );
      save(spec.id + "-observations.json", record);
      console.log(
        JSON.stringify({
          phase: "observed",
          case: spec.id,
          completion_ms: record.measured_ms,
          wire_bytes: wire,
        }),
      );
      // These are the three exact synthetic files created only by this test's
      // already quiescent Bash; never remove a live work marker.
      assert(
        !groupAlive(
          work.evidence.quiescent.work.processes,
          work.evidence.started.work.pgid,
        ),
      );
      await joinedRuntimeExec({
        args: [
          "exec",
          "--user",
          "1000:1000",
          work.evidence.container.id,
          "sh",
          "-c",
          "rm -- " +
            cacheRuntimeFiles.started +
            " " +
            cacheRuntimeFiles.effects,
        ],
        environment: config.env,
        signal,
      });
    }
    for (const ref of streams) await closeStream(ref);
    evidence.model = await model();
    assert.equal(evidence.model.requests.length, 8);
    await delay(6500, undefined, { signal });
    const traces = new Map();
    const getTrace = async (id) => {
      if (traces.has(id)) return traces.get(id);
      assert.match(id, /^[a-f0-9]{32}$/u);
      const response = await fetch(config.jaeger + "/api/traces/" + id, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      const text = await response.text();
      save("trace-" + id + ".json", text);
      assert.equal(response.status, 200);
      const body = JSON.parse(text);
      assert.equal(body.errors?.length ?? 0, 0);
      assert.equal(body.data?.length, 1);
      assert.equal(body.data[0].traceID, id);
      traces.set(id, body.data[0]);
      return body.data[0];
    };
    for (const record of cases) {
      for (const receipt of [
        record.upload,
        record.cancel,
        record.overflow,
        ...record.calibration.before,
        ...record.calibration.after,
      ])
        receipt.trace = await getTrace(receipt.trace_id);
      record.work_trace = await getTrace(record.held_model.trace_id);
      record.upload_work_trace = await getTrace(record.upload_model.trace_id);
      for (const pool of record.pool) {
        const ref = streams.find((row) => row.trace_id === pool.trace_id);
        Object.assign(pool, {
          closed_ns: ref.closed_ns,
          joined: ref.joined,
          raw: ref.raw,
          trace: await getTrace(ref.trace_id),
        });
      }
      save(record.id + "-evidence.json", record);
    }
    // Preserve every original case before admitting any: a failure in one
    // oracle must not discard the remaining cases' timing and source evidence.
    const gateFailures = [];
    for (const record of cases) {
      try {
        evidence.checks.push({
          case: record.id,
          passed: true,
          ...inspectCapacityCase(record),
        });
      } catch (error) {
        gateFailures.push(error);
        evidence.checks.push({
          case: record.id,
          passed: false,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });
      }
    }
    assert.equal(evidence.checks.length, 4);
    if (gateFailures.length)
      throw new AggregateError(gateFailures, "capacity case admission failed");
    evidence.business_passed = true;
  } catch (error) {
    failure = error;
    evidence.failure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    for (const upload of uploads) await attempt(() => upload.closeAndWait());
    for (const ref of streams) await attempt(() => closeStream(ref));
    if (config) {
      const docker = dockerClient(config.env, undefined, 180000);
      await attempt(async () =>
        save(
          "service-logs.txt",
          await docker(
            composeArgs(config.project, [
              "-f",
              "tests/e2e/workspace-closeout/c4.compose.yaml",
              "-f",
              "tests/e2e/agent-ui/upload-capacity.compose.yaml",
              "logs",
              "--no-color",
              "--tail",
              "200",
            ]),
            true,
            { captureStderr: true },
          ),
        ),
      );
      await attempt(() => cleanup(config, docker));
      for (const image of candidates)
        await attempt(async () => {
          if (
            await docker([
              "image",
              "ls",
              "-q",
              "--filter",
              "reference=" + image,
            ])
          ) {
            assert.equal(
              await docker([
                "image",
                "inspect",
                "--format",
                '{{index .Config.Labels "' + ownerLabel + '"}}',
                image,
              ]),
              config.project,
            );
            await docker(["image", "rm", image]);
          }
        });
    }
    if (before)
      await attempt(async () => {
        const after = await snapshotEnvironment({ before });
        evidence.environment = compareEnvironment(before, after);
        save("environment-after.json", after);
        assert(
          evidence.environment.unchanged,
          "Docker environment not restored",
        );
      });
    evidence.streams = streams.map(({ stream, ...ref }) => ({
      ...ref,
      raw: ref.raw ?? stream.evidence,
    }));
    evidence.cleanup_errors = problems.map((e) => ({
      name: e.name,
      message: e.message,
    }));
    if (output) await attempt(async () => save("result.json", evidence));
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  const errors = [...(failure ? [failure] : []), ...problems];
  if (errors.length)
    throw new AggregateError(errors, "capacity integration failed");
  console.log(
    JSON.stringify({ phase: "complete", checks: evidence.checks, output }),
  );
  return evidence;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  runCapacity().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
