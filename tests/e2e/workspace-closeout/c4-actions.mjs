import assert from "node:assert/strict";
import { assertC4BodyDiagnostics } from "./c4-body-audit.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { writeEvidenceFile } from "../../support/storage.mjs";
import {
  dockerClient,
  cleanup,
  composeArgs,
  scopeLabel,
  lines,
} from "../lifecycle-closeout/docker.mjs";
import {
  flushTraceProducers,
  assertProducerStopped,
} from "../lifecycle-closeout/network-support.mjs";
import { c4Configuration } from "./c4-configuration.mjs";
import { setup } from "./c4-setup.mjs";
import { runBrowser } from "./c4-browser.mjs";
import { captureC4Runtime } from "./c4-runtime.mjs";
import { assertWorkspaceBytes } from "./browser-control.mjs";
import {
  snapshotC4Execution,
  c4OffboardingExpected,
  assertC4NoNewExecution,
} from "./c4-revocation.mjs";
import { assertC4ExecutionInventory } from "./c4-inventory.mjs";
import { c4TraceInventory, collectC4Trace } from "./c4-collection.mjs";
import { assertC4CollectedSources } from "./c4-admission.mjs";

const checks = [
  "workspace context above conversation navigation",
  "member_login_new_load_session_real_tools",
  "cross_page_metadata_matches_list_and_reload",
  "attachment_bytes_previews_format_and_capability_rejections",
  "real_tool_permission_interaction",
  "two_sessions_busy_cancel_and_readmission",
  "offline_completion_history_without_resubmission",
  "close_reopen_history_without_resubmission",
  "open_page_rebuild_retains_workspace_and_history",
  "mobile_layout_input_completion",
  "open_page_identity_revocation",
  "private_runtime_and_provider_data_absent",
];
const fail = (errors, message) => {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, message);
};

export function createC4Actions({ signal, output, report }, overrides = {}) {
  const deps = {
    configuration: c4Configuration,
    createDocker: dockerClient,
    setup,
    browser: runBrowser,
    captureRuntime: captureC4Runtime,
    snapshot: snapshotC4Execution,
    flushShared: flushTraceProducers,
    cleanup,
    request: fetch,
    write: writeEvidenceFile,
    ...overrides,
  };
  let inventory = [],
    failureIndex = 0;
  const secrets = (config) => [
    "stage3-model-secret",
    "c4-member-password",
    ...Object.entries(config.env)
      .filter(
        ([key, value]) =>
          /TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL/iu.test(key) &&
          typeof value === "string" &&
          value.length >= 8,
      )
      .map(([, value]) => value),
  ];
  const model = async (config) => {
    signal?.throwIfAborted();
    const response = await deps.request(config.model + "/status", {
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(5000)].filter(Boolean),
      ),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const actions = {
    configure: (allocated) =>
      deps.configuration(signal, (project) =>
        allocated({ project, env: { ...process.env } }),
      ),
    async deploy(config, current) {
      current.runtime_image = config.image;
      const docker = deps.createDocker(config.env, signal, 1200000);
      current.agent_ui_image = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        config.agentUIImage,
      ]);
      await actions.checkpoint(current);
      await docker(
        config.compose([
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "180",
          "--no-build",
        ]),
        true,
      );
    },
    async setup(config, current) {
      const fixture = await deps.setup(config, signal),
        docker = deps.createDocker(config.env, signal, 1200000);
      current.agent_id = fixture.agentID;
      fixture.captureRuntime = (name) =>
        deps.captureRuntime(name, {
          config,
          fixture,
          docker,
          signal,
          report: current,
        });
      await fixture.captureRuntime("initial");
      fixture.verifyWorkspace = async () => {
        const ids = lines(
          await docker([
            "ps",
            "-q",
            "--no-trunc",
            "--filter",
            `label=${scopeLabel}=${config.project}`,
            "--filter",
            `label=io.antnest.agent-id=${fixture.agentID}`,
          ]),
        );
        assert.equal(ids.length, 1);
        const encoded = await docker([
          "exec",
          "--user",
          "1000:1000",
          ids[0],
          "base64",
          "-w",
          "0",
          "/workspace/.c4-browser-note",
        ]);
        current.workspace_receipt = { container_id: ids[0], encoded };
        assertWorkspaceBytes(encoded);
      };
      return fixture;
    },
    browser: (config, fixture, current, checkpoint) =>
      deps.browser(config, fixture, signal, output, current, checkpoint),
    async refreshModel(config, _fixture, current) {
      current.model = await model(config);
    },
    async refreshAudits(config, fixture, current) {
      current.execution = await deps.snapshot(fixture, () => model(config));
    },
    async refreshRevocation(_config, fixture, current) {
      const revoke = current.browser_revocation;
      if (!revoke?.cause?.traceID) return;
      if (current.execution) revoke.after = structuredClone(current.execution);
      revoke.events_after = await fixture.json(
        `/api/admin/agents/${fixture.agentID}/events?limit=100`,
      );
      revoke.offboarding_expected = c4OffboardingExpected({
        before: revoke.events_before,
        after: revoke.events_after,
        traceID: revoke.cause.traceID,
        agentId: fixture.agentID,
        ownerId: fixture.ownerID,
      });
    },
    async flush(config, current) {
      const docker = deps.createDocker(config.env, signal, 120000),
        errors = [];
      const observed = (current.producer_flush = {});
      try {
        signal?.throwIfAborted();
        await docker(config.compose(["stop", "-t", "30", "agent-ui"]), true);
        const ids = lines(
          await docker(config.compose(["ps", "-a", "-q", "agent-ui"])),
        );
        assert.equal(ids.length, 1);
        const containers = JSON.parse(await docker(["inspect", ...ids]));
        assert.equal(containers.length, 1);
        observed.agent_ui = containers[0];
        assert.equal(
          containers[0].Config.Labels["com.docker.compose.service"],
          "agent-ui",
        );
        assertProducerStopped(containers[0], config.project);
      } catch (error) {
        errors.push(error);
      }
      try {
        signal?.throwIfAborted();
        observed.shared_services = await deps.flushShared(config, docker);
      } catch (error) {
        errors.push(error);
      }
      fail(errors, "C4 producer flush failed");
      observed.completed = true;
    },
    inventory(current, config) {
      inventory = c4TraceInventory(current, config);
      current.collection_inventory = structuredClone(inventory);
      return inventory;
    },
    collect: (row, config, _current, diagnosticSignal) =>
      collectC4Trace(config.jaeger, row, {
        inventory,
        directory: output + "/traces",
        signal: diagnosticSignal,
        secrets: secrets(config),
        flush: async () => diagnosticSignal?.throwIfAborted(),
      }),
    preserve: (row, error) =>
      deps.write(
        output,
        `trace-failure-${++failureIndex}.private.txt`,
        inspect({ expected: row, error }, { depth: 8 }),
      ),
    inspectTraces(current, config) {
      const expected = c4TraceInventory(current, config);
      assert.equal(
        expected.length,
        15,
        "eleven C4 Prompts and four revocation roots required",
      );
      assert.equal(
        expected.filter((row) => row.kind === "c4_revocation").length,
        4,
      );
      return assertC4CollectedSources(
        expected,
        current.traces,
        secrets(config),
      );
    },
    admit(current, config) {
      assert.equal(
        current.business_completed,
        true,
        "C4 browser business incomplete",
      );
      assert.deepEqual(
        current.checks,
        checks,
        "complete C4 browser checks required",
      );
      assert.equal(current.browser_errors, 0);
      assert(current.browser_payloads_checked > 0);
      assertC4ExecutionInventory(current);
      assertC4NoNewExecution(
        current.browser_revocation.before,
        current.execution,
      );
      assert.equal(
        current.workspace_receipt.container_id,
        current.runtime_bindings[1].observed.container.Id,
      );
      assertWorkspaceBytes(current.workspace_receipt.encoded);
      assert.equal(current.producer_flush.completed, true);
      assert.equal(current.producer_flush.shared_services, 7);
      assertProducerStopped(current.producer_flush.agent_ui, config.project);
      current.browser_body_review = assertC4BodyDiagnostics(current, config);
      assert.equal(
        current.browser_bodies_unobserved,
        (current.bootstrap_denials?.length ?? 0) +
          current.browser_body_review.body_count,
      );
      assert.equal(current.browser_payload_coverage, "observed_bodies_only");
      return {
        exitCode: 0,
        rawExitCode: current.trace_outcome?.exit_code ?? null,
        strict_trace: current.trace_outcome?.strict_trace ?? "not_collected",
        reviewed_error_spans: current.trace_outcome?.reviewed_error_spans ?? 0,
        runs: 11,
        provider_requests: 14,
        runtime_tool_calls: 4,
        trace_roots: current.traces.length,
      };
    },
    async logs(config, current) {
      const docker = deps.createDocker(config.env, undefined, 30000),
        errors = [];
      try {
        const ids = lines(
          await docker([
            "ps",
            "-aq",
            "--filter",
            `label=com.docker.compose.project=${config.project}`,
          ]),
        );
        current.startup = ids.length
          ? JSON.parse(await docker(["inspect", ...ids]))
          : [];
      } catch (error) {
        errors.push(error);
      }
      try {
        const args = ["logs", "--no-color", "--tail", "200"];
        const logs = await docker(
          config.compose
            ? config.compose(args)
            : composeArgs(config.project, args),
        );
        deps.write(output, "failure-services.private.log", logs);
      } catch (error) {
        errors.push(error);
      }
      fail(errors, "C4 failure evidence could not be fully archived");
    },
    async cleanup(config) {
      const root = fileURLToPath(new URL("../../../", import.meta.url));
      const credentials = resolve(
        root,
        "artifacts/verification/authenticated-e2e",
        config.project,
        "credentials",
      );
      await deps.cleanup({
        ...config,
        ...(existsSync(credentials) ? { credentials } : {}),
      });
    },
    checkpoint: (current = report) =>
      deps.write(
        output,
        "report.private.json",
        JSON.stringify(current, null, 2) + "\n",
      ),
  };
  return actions;
}
