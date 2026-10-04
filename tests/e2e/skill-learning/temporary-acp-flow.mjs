import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { composeArgs } from "../lifecycle-closeout/docker.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { assertCaptureDisabled, tag } from "../observability/trace-tree.mjs";
export async function temporaryAcpFlow({
  config,
  docker,
  overlay,
  root,
  image,
  targetId,
  sourceId,
  sql,
  signal,
}) {
  const output = `${root}/artifacts/verification/skill-discovery-d4a-20261001`;
  await mkdir(output, { recursive: true, mode: 0o700 });
  const clients = [];
  const memberClient = new GatewayClient(config.gateway);
  await memberClient.request("/api/session/login", { body: member });
  for (const mode of ["use", "cancel", "restart", "retry"]) {
    console.log(`Temporary acceptance ${config.project}: ${mode}`);
    const name = `${config.project}-temporary-${mode}`;
    try {
      const args = [
        "run",
        ...(mode === "restart" ? ["-d"] : []),
        "--name",
        name,
        "--label",
        `com.docker.compose.project=${config.project}`,
        "--network",
        `${config.project}_gateway-ingress`,
        "-e",
        `ANTNEST_E2E_MODEL_URL=${config.model.replace("127.0.0.1", "host.docker.internal")}`,
        "-e",
        `ANTNEST_E2E_AGENT_ID=${targetId}`,
        "-e",
        `ANTNEST_E2E_TEMPORARY_MODE=${mode}`,
        "-e",
        `ANTNEST_E2E_MEMBER_COOKIE=${memberClient.cookie}`,
        "-v",
        `${root}/tests:/app/tests:ro`,
        image,
        "node",
        "/app/tests/e2e/skill-learning/temporary-acp-client.mjs",
      ];
      let text = await docker(args, true);
      if (mode === "restart") {
        await until(
          async () =>
            Number(
              await sql(
                `SELECT count(*) FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.agent_id='${targetId}' AND t.released_at IS NULL AND r.state='running' AND EXISTS(SELECT 1 FROM tool_attempts a WHERE a.run_id=r.id AND a.tool_name='bash' AND a.state='completed')`,
              ),
            ) > 0,
          "real temporary files used before normal ACP restart",
          signal,
        );
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "restart",
            "--timeout",
            "20",
            "agent-acp-service",
          ]),
          true,
        );
        assert.equal(await docker(["wait", name], true), "0");
        text = await docker(["logs", name]);
      }
      const result = JSON.parse(text.trim().split("\n").at(-1));
      clients.push(result);
      await until(
        async () =>
          (await sql(
            `SELECT count(*) FROM temporary_skill_scopes WHERE agent_id='${targetId}' AND released_at IS NULL`,
          )) === "0",
        "confirmed temporary release",
        signal,
        90000,
      );
      const files = await docker([
        "exec",
        `antnest-runtime-${targetId}`,
        "sh",
        "-ec",
        "if test -d /workspace/.antnest/skill-temporary/v1; then find /workspace/.antnest/skill-temporary/v1 -mindepth 1 -maxdepth 1 -print; fi; test ! -e /workspace/.antnest/skills/temporary-procedure; test ! -e /skills/temporary-procedure",
      ]);
      assert.equal(files, "");
    } catch (error) {
      const logs = await docker(["logs", name]).catch(
        () => "client logs unavailable",
      );
      await writeFile(`${output}/${config.project}-${mode}-failure.log`, logs, {
        flag: "wx",
        mode: 0o600,
      });
      throw error;
    } finally {
      await docker(["rm", "-f", name]).catch(() => undefined);
    }
  }
  const scopes = JSON.parse(
    await sql(
      `SELECT json_agg(json_build_object('run_id',t.run_id,'released',t.released_at IS NOT NULL,'run_state',r.state,'tools',(SELECT json_agg(json_build_object('source',a.source,'name',a.tool_name,'effect',a.tool_effect_state,'stopped',a.runtime_call_stopped) ORDER BY a.started_at,a.id) FROM tool_attempts a WHERE a.run_id=t.run_id)) ORDER BY t.created_at) FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.agent_id='${targetId}'`,
    ),
  );
  assert.equal(scopes.length, 3);
  for (const scope of scopes) {
    assert(scope.released);
    assert.notEqual(scope.run_state, "running");
    const load = scope.tools.find((tool) => tool.name === "load_skill");
    assert.equal(load.source, "agent");
    assert.equal(load.effect, "settled");
    assert.equal(load.stopped, true);
    assert(scope.tools.some((tool) => tool.name === "read"));
    assert(scope.tools.some((tool) => tool.name === "bash"));
  }
  await docker([
    "exec",
    `antnest-runtime-${sourceId}`,
    "test",
    "-f",
    "/workspace/.antnest/skills/fixture-procedure/SKILL.md",
  ]);
  const traces = await until(
    async () => {
      const found = await searchJaegerTraces(
        config.jaeger,
        new URLSearchParams({
          service: "agent-acp-service",
          operation: "skill.temporary.install",
          tags: JSON.stringify({ "antnest.agent_id": targetId }),
          lookback: "30m",
          limit: "20",
        }),
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
      );
      return found.length === 3 &&
        found.every((trace) =>
          trace.spans.some(
            (span) => span.operationName === "runtime.skill.temporary.install",
          ),
        )
        ? found
        : null;
    },
    "exported real temporary install traces",
    signal,
    45000,
  );
  for (const trace of traces) {
    assertCaptureDisabled(trace);
    const install = trace.spans.find(
      (span) => span.operationName === "skill.temporary.install",
    );
    const native = trace.spans.find(
      (span) => span.operationName === "runtime.skill.temporary.install",
    );
    assert.equal(tag(install, "antnest.run_id"), tag(native, "run.id"));
    assert(
      trace.spans.some((span) => span.operationName === "skill.discovery.load"),
    );
    assert(!JSON.stringify(trace).includes("Run scripts/check.sh"));
  }
  const releases = await until(
    async () => {
      const found = await searchJaegerTraces(
        config.jaeger,
        new URLSearchParams({
          service: "agent-acp-service",
          operation: "skill.temporary.release",
          tags: JSON.stringify({ "antnest.agent_id": targetId }),
          lookback: "30m",
          limit: "30",
        }),
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
      );
      return scopes.every((scope) =>
        found.some((trace) =>
          trace.spans.some(
            (span) =>
              span.operationName === "runtime.skill.temporary.release" &&
              tag(span, "run.id") === scope.run_id &&
              tag(span, "skill.temporary.outcome") === "released",
          ),
        ),
      )
        ? found
        : null;
    },
    "confirmed temporary release traces including restart recovery",
    signal,
    45000,
  );
  for (const trace of releases) {
    assertCaptureDisabled(trace);
    assert(!JSON.stringify(trace).includes("Run scripts/check.sh"));
  }
  assertTemporaryParentage(traces, "install");
  assertTemporaryParentage(releases, "release");
  await writeFile(
    `${output}/${config.project}-temporary-traces.json`,
    JSON.stringify({ installs: traces, releases }),
    { flag: "wx", mode: 0o600 },
  );
  const result = {
    source_agent_id: sourceId,
    target_agent_id: targetId,
    clients,
    scopes,
    trace_ids: traces.map((trace) => trace.traceID),
    cleanup_trace_ids: releases.map((trace) => trace.traceID),
  };
  await writeFile(
    `${output}/${config.project}-temporary-business.json`,
    JSON.stringify(result),
    { flag: "wx", mode: 0o600 },
  );
  return result;
}

export function assertTemporaryParentage(traces, action) {
  for (const trace of traces) {
    for (const native of trace.spans.filter(
      (span) => span.operationName === `runtime.skill.temporary.${action}`,
    )) {
      let node = native,
        matched = false;
      const seen = new Set();
      for (;;) {
        assert(!seen.has(node.spanID));
        seen.add(node.spanID);
        const parent = node.references.find(
          (ref) => ref.refType === "CHILD_OF",
        );
        if (!parent) break;
        assert.equal(parent.traceID, trace.traceID);
        node = trace.spans.find((span) => span.spanID === parent.spanID);
        assert(node, "missing parent of Native temporary span");
        if (node.operationName === `skill.temporary.${action}`) {
          matched = true;
          break;
        }
      }
      assert(
        matched,
        "Native temporary call must descend from its ACP consumer span",
      );
    }
  }
}
