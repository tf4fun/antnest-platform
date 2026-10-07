import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import {
  setup,
  member as fixtureMember,
  until,
} from "../workspace-closeout/c4-setup.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { skillClientArgs } from "./client-container.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const reviewSkip = process.env.ANTNEST_E2E_REVIEW_SKIP === "true";
const reviewUntrusted = process.env.ANTNEST_E2E_REVIEW_UNTRUSTED === "true";
const reviewRecovery = process.env.ANTNEST_E2E_REVIEW_RECOVERY === "true";
const reviewBrowser = process.env.ANTNEST_E2E_SKILL_BROWSER === "true";
assert(
  !reviewBrowser || reviewRecovery,
  "browser diagnostics use the model-recovery scenario",
);
const reviewFailure =
  reviewRecovery || process.env.ANTNEST_E2E_REVIEW_FAILURE === "true";
const reviewRestart = process.env.ANTNEST_E2E_REVIEW_RESTART === "true";
const reviewPolicyOff = process.env.ANTNEST_E2E_POLICY_OFF === "true";
const reviewDisable = process.env.ANTNEST_E2E_LIFECYCLE_DISABLE === "true";
const reviewRebuild = process.env.ANTNEST_E2E_LIFECYCLE_REBUILD === "true";
const lifecycleClosed = reviewDisable || reviewRebuild;
assert(
  [
    reviewSkip,
    reviewUntrusted,
    reviewFailure,
    reviewRestart,
    reviewPolicyOff,
    reviewDisable,
    reviewRebuild,
  ].filter(Boolean).length <= 1,
);
const scenario = reviewRebuild
  ? "lifecycle-rebuild"
  : reviewDisable
    ? "lifecycle-disable"
    : reviewPolicyOff
      ? "policy-off"
      : reviewRestart
        ? "restart"
        : reviewRecovery
          ? reviewBrowser
            ? "model-recovery-browser"
            : "model-recovery"
          : reviewFailure
            ? "model-failure"
            : reviewUntrusted
              ? "untrusted-only"
              : reviewSkip
                ? "skip"
                : "preempt";
const overlay = [
  "-f",
  "tests/e2e/workspace-closeout/c4.compose.yaml",
  "-f",
  "tests/e2e/skill-learning/compose.yaml",
];
const evidenceDir = fileURLToPath(
  new URL("../../../artifacts/verification/skill-learning/", import.meta.url),
);

test(
  reviewRebuild
    ? "rebuilding an Agent during review prevents a late Skill commit"
    : reviewDisable
      ? "disabling an Agent during review cancels learning without a Skill change"
      : reviewPolicyOff
        ? "turning learning off during review prevents a Skill change"
        : reviewRestart
          ? "ACP restart during review preserves an unknown model call and foreground access"
          : reviewRecovery
            ? "a new source learns after model recovery without replaying the failed review or blocking foreground"
            : reviewFailure
              ? "a review model outage does not change the completed Run or create a Skill"
              : reviewUntrusted
                ? "tool output alone cannot authorize an automatic Skill rule"
                : reviewSkip
                  ? "a completed Run can settle a skipped Skill review without a change notice"
                  : "foreground Run cancels an in-flight Skill review without applying it",
  { timeout: 720_000 },
  async () => {
    process.chdir(root);
    const abort = new AbortController();
    const interrupt = () =>
      abort.abort(new Error("Skill learning E2E interrupted"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let config;
    let learningBrowser;
    try {
      config = await configuration(abort.signal);
      const keys = generateKeyPairSync("ed25519");
      const rawPublic = keys.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      assert.equal(rawPublic.length, 32);
      const image = `antnest/agent-acp-service:skill-learning-${config.project.slice(-8)}`;
      const uiImage = `antnest/agent-ui:skill-learning-${config.project.slice(-8)}`;
      Object.assign(config.env, {
        ANTNEST_C4_AGENT_ACP_IMAGE: image,
        ...(reviewRecovery ? { ANTNEST_C4_AGENT_UI_IMAGE: uiImage } : {}),
        ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
          config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
        ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
          config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(
            ".0/24",
            ".128/25",
          ),
        ANTNEST_E2E_SKILL_SIGNING_KEY: keys.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64"),
        ANTNEST_E2E_SKILL_MAINTENANCE_VERIFIERS: JSON.stringify({
          keys: [
            {
              kid: "fixture-key",
              algorithm: "Ed25519",
              public_key_base64url: rawPublic.toString("base64url"),
            },
          ],
        }),
        ANTNEST_E2E_HOLD_REVIEW:
          reviewSkip || reviewUntrusted || reviewFailure ? "false" : "true",
        ANTNEST_E2E_REVIEW_SKIP: reviewSkip ? "true" : "false",
        ANTNEST_E2E_REVIEW_FAILURE: reviewFailure ? "true" : "false",
        ANTNEST_E2E_REVIEW_UNTRUSTED: reviewUntrusted ? "true" : "false",
      });
      const docker = dockerClient(config.env, abort.signal, 720_000);
      await docker(
        [
          "build",
          "-f",
          "services/agent-acp-service/Dockerfile",
          "-t",
          image,
          ".",
        ],
        true,
      );
      if (reviewRecovery)
        await docker(
          ["build", "-f", "services/agent-ui/Dockerfile", "-t", uiImage, "."],
          true,
        );
      await docker(
        composeArgs(config.project, [
          ...overlay,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "180",
          "--no-build",
        ]),
        true,
      );
      const fixture = await setup(config, abort.signal);
      const clientName = `${config.project}-skill-learning-${scenario}`;
      const postgres = await docker(
        composeArgs(config.project, [...overlay, "ps", "-q", "postgres"]),
      );
      assert(postgres);
      const sql = async (query) =>
        docker([
          "exec",
          "-e",
          "PGPASSWORD=antnest-agent-acp-dev",
          postgres,
          "psql",
          "-U",
          "antnest_agent_acp",
          "-d",
          "antnest_agent_acp",
          "-Atc",
          query,
        ]);
      let output;
      try {
        output = await docker(
          [
            "run",
            "--name",
            clientName,
            ...skillClientArgs(config, {
              grants: reviewPolicyOff
                ? ["acp-controller", "console-controller", "gateway-identity"]
                : [],
            }),
            "-e",
            `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
            ...(reviewFailure ? ["-e", "ANTNEST_E2E_REVIEW_FAILURE=true"] : []),
            ...(reviewUntrusted
              ? ["-e", "ANTNEST_E2E_REVIEW_UNTRUSTED=true"]
              : []),
            ...(reviewRestart || lifecycleClosed
              ? ["-e", "ANTNEST_E2E_STOP_AFTER_PENDING=true"]
              : []),
            ...(reviewDisable
              ? ["-e", "ANTNEST_E2E_LIFECYCLE_DISABLE=true"]
              : []),
            ...(reviewRebuild
              ? ["-e", "ANTNEST_E2E_LIFECYCLE_REBUILD=true"]
              : []),
            ...(reviewPolicyOff ? ["-e", "ANTNEST_E2E_POLICY_OFF=true"] : []),
            "-v",
            `${root}/tests:/app/tests:ro`,
            image,
            "node",
            reviewSkip || reviewUntrusted || reviewFailure
              ? "/app/tests/e2e/skill-learning/skip-client.mjs"
              : "/app/tests/e2e/skill-learning/preempt-client.mjs",
          ],
          true,
        );
      } catch (error) {
        const clientLog = spawnSync(
          "docker",
          ["logs", "--tail", "200", clientName],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          },
        );
        const modelContainer = await docker(
          composeArgs(config.project, [...overlay, "ps", "-q", "stage3-model"]),
        ).catch(() => "");
        const modelStatus = modelContainer
          ? await docker([
              "exec",
              modelContainer,
              "node",
              "-e",
              "fetch('http://127.0.0.1:8080/status').then(r=>r.text()).then(console.log)",
            ]).catch(() => "unavailable")
          : "unavailable";
        const tasks = await sql(
          "SELECT state,COALESCE(pause_reason,''),model_calls FROM learning_tasks ORDER BY created_at",
        ).catch(() => "unavailable");
        await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
        await writeFile(
          `${evidenceDir}${config.project}.${scenario}-failure.json`,
          JSON.stringify({
            clientLog: `${clientLog.stdout ?? ""}\n${clientLog.stderr ?? ""}`,
            modelStatus,
            tasks,
          }),
          { flag: "wx", mode: 0o600 },
        );
        throw new Error(
          `Skill learning preemption client failed: ${clientLog.stderr ?? ""}; model=${modelStatus}; tasks=${tasks}`,
          { cause: error },
        );
      }
      const result = JSON.parse(output.trim().split("\n").at(-1));
      assert.equal(
        result.status,
        reviewRebuild
          ? "review_pending_for_rebuild"
          : reviewDisable
            ? "review_pending_for_disable"
            : reviewPolicyOff
              ? "policy_off_during_review"
              : reviewRestart
                ? "review_pending_for_restart"
                : reviewFailure
                  ? "review_model_failure_requested"
                  : reviewUntrusted
                    ? "review_untrusted_only_requested"
                    : reviewSkip
                      ? "review_skip_requested"
                      : "foreground_preempted_review",
      );
      let lifecycleModel;
      if (lifecycleClosed) {
        const accepted = await fixture.json(
          `/api/admin/agents/${fixture.agentID}/${reviewRebuild ? "rebuild" : "disable"}`,
          {
            status: 202,
            headers: { "Idempotency-Key": randomUUID() },
            body: reviewRebuild
              ? {
                  template_id: fixture.template.template_id,
                  template_revision: fixture.template.revision,
                }
              : {},
          },
        );
        await fixture.operation((accepted.operation ?? accepted).request_id);
        if (reviewRebuild) await fixture.ready();
        const modelContainer = await docker(
          composeArgs(config.project, [...overlay, "ps", "-q", "stage3-model"]),
        );
        lifecycleModel = await until(
          async () => {
            const raw = await docker([
              "exec",
              modelContainer,
              "node",
              "-e",
              "fetch('http://127.0.0.1:8080/status').then(r=>r.text()).then(console.log)",
            ]);
            const status = JSON.parse(raw);
            return status.cancelled.includes("review-create") ? status : null;
          },
          `review model cancelled after Agent ${reviewRebuild ? "rebuild" : "disable"}`,
          abort.signal,
          15_000,
        );
        assert.deepEqual(lifecycleModel.pending, []);
      }
      let restartedForeground;
      if (reviewRestart) {
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "restart",
            "agent-acp-service",
          ]),
          true,
        );
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            "--no-build",
            "agent-acp-service",
          ]),
          true,
        );
        const restartClientName = `${config.project}-skill-learning-after-restart`;
        let resumed;
        try {
          resumed = await docker(
            [
              "run",
              "--name",
              restartClientName,
              ...skillClientArgs(config),
              "-e",
              `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
              "-e",
              `ANTNEST_E2E_SESSION_ID=${result.session_id}`,
              "-v",
              `${root}/tests:/app/tests:ro`,
              image,
              "node",
              "/app/tests/e2e/skill-learning/restart-client.mjs",
            ],
            true,
          );
        } catch (error) {
          const clientLog = spawnSync(
            "docker",
            ["logs", "--tail", "200", restartClientName],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 10_000,
            },
          );
          const modelContainer = await docker(
            composeArgs(config.project, [
              ...overlay,
              "ps",
              "-q",
              "stage3-model",
            ]),
          ).catch(() => "");
          const modelStatus = modelContainer
            ? await docker([
                "exec",
                modelContainer,
                "node",
                "-e",
                "fetch('http://127.0.0.1:8080/status').then(r=>r.text()).then(console.log)",
              ]).catch(() => "unavailable")
            : "unavailable";
          const tasks = await sql(
            "SELECT state,COALESCE(pause_reason,''),model_calls FROM learning_tasks ORDER BY created_at",
          ).catch(() => "unavailable");
          await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
          await writeFile(
            `${evidenceDir}${config.project}.restart-client-failure.json`,
            JSON.stringify({
              clientLog: `${clientLog.stdout ?? ""}\n${clientLog.stderr ?? ""}`,
              modelStatus,
              tasks,
            }),
            { flag: "wx", mode: 0o600 },
          );
          throw new Error(
            `Foreground after ACP restart failed: ${clientLog.stderr ?? ""}; model=${modelStatus}; tasks=${tasks}`,
            { cause: error },
          );
        }
        restartedForeground = JSON.parse(resumed.trim().split("\n").at(-1));
        assert.equal(
          restartedForeground.status,
          "foreground_after_acp_restart",
        );
      }
      const tasks = await until(
        async () => {
          const value = (
            await sql(
              `SELECT state,COALESCE(pause_reason,''),model_calls FROM learning_tasks WHERE agent_id='${fixture.agentID}' ORDER BY created_at`,
            )
          ).trim();
          const expected = reviewFailure
            ? "paused|runtime_unavailable|1"
            : reviewUntrusted
              ? "paused|review_inconclusive|2"
              : lifecycleClosed
                ? "paused|lifecycle_closed|1"
                : reviewPolicyOff
                  ? "paused|policy_changed|1"
                  : reviewSkip
                    ? "skipped||1"
                    : "paused|foreground_preempted|1";
          return value === (reviewRestart ? "paused|worker_lost|1" : expected)
            ? value
            : null;
        },
        reviewRestart
          ? "paused review after ACP restart"
          : lifecycleClosed
            ? `paused review after Agent ${reviewRebuild ? "rebuild" : "disable"}`
            : reviewPolicyOff
              ? "paused review after policy off"
              : reviewFailure
                ? "paused failed review model"
                : reviewUntrusted
                  ? "paused untrusted-only review"
                  : reviewSkip
                    ? "settled skipped review"
                    : "paused preempted review",
        abort.signal,
        30_000,
      );
      if (lifecycleClosed) {
        // Let the two-second paused-task recovery loop revisit the closed Agent.
        await delay(3_000, undefined, { signal: abort.signal });
        const afterRecovery = (
          await sql(
            `SELECT state,COALESCE(pause_reason,''),model_calls FROM learning_tasks WHERE agent_id='${fixture.agentID}' ORDER BY created_at`,
          )
        ).trim();
        assert.equal(afterRecovery, tasks);
      }
      const changes = (
        await sql(
          `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
        )
      ).trim();
      assert.equal(changes, "0");
      let modelCallState;
      if (
        reviewFailure ||
        reviewRestart ||
        reviewPolicyOff ||
        lifecycleClosed
      ) {
        modelCallState = (
          await sql(
            `SELECT call.state FROM learning_model_calls call JOIN learning_tasks task ON task.id=call.task_id WHERE task.agent_id='${fixture.agentID}' ORDER BY call.call_index`,
          )
        ).trim();
        assert.equal(modelCallState, "unknown");
      }
      if (
        reviewSkip ||
        reviewUntrusted ||
        reviewFailure ||
        reviewRestart ||
        reviewPolicyOff ||
        lifecycleClosed
      ) {
        const member = new GatewayClient(config.gateway);
        await member.request("/api/session/login", { body: fixtureMember });
        const view = (
          await member.request(
            `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${result.session_id}`,
          )
        ).body;
        assert.deepEqual(view.systemNotices ?? [], []);
      }
      let modelRecovery;
      if (reviewRecovery) {
        const failedReceipt = async () =>
          JSON.parse(
            await sql(
              `SELECT row_to_json(receipt) FROM (
             SELECT task.id AS task_id,task.source_run_id,task.state AS task_state,
                    task.pause_reason,task.generation,task.claim_id,task.model_calls,
                    source.state AS source_state,call.request_id,call.state AS call_state,
                    call.reserved_input_tokens,call.reserved_output_tokens,
                    call.reserved_duration_ms,call.actual_input_tokens,call.actual_output_tokens
             FROM learning_tasks task JOIN runs source ON source.id=task.source_run_id
             JOIN learning_model_calls call ON call.task_id=task.id
             WHERE task.agent_id='${fixture.agentID}' AND call.state='unknown'
           ) receipt`,
            ),
          );
        const before = await failedReceipt();
        assert.equal(before.source_state, "completed");
        assert.equal(before.task_state, "paused");
        assert.equal(before.call_state, "unknown");
        assert.match(before.source_run_id, /^run_[a-f0-9]{32}$/u);
        assert.equal(before.actual_input_tokens, null);
        assert.equal(before.actual_output_tokens, null);
        if (reviewBrowser) {
          const { openLearningBrowser } =
            await import("./browser-learning.mjs");
          learningBrowser = await openLearningBrowser({
            config,
            fixture,
            signal: abort.signal,
            sessionId: result.session_id,
            output: `${evidenceDir}${config.project}.browser/`,
          });
          await learningBrowser.inspectDeferredReview(before.source_run_id);
        }
        // Advance only this disposable attempt's cooldown; keep its cost reservation intact.
        const advanced = await sql(
          `UPDATE learning_review_attempts SET started_at=clock_timestamp()-interval '11 minutes'
           WHERE task_id='${before.task_id}'`,
        );
        assert.equal(advanced.trim(), "UPDATE 1");
        const recoveryClientName = `${config.project}-skill-learning-after-model-recovery`;
        let recovered;
        try {
          recovered = await docker(
            [
              "run",
              "--name",
              recoveryClientName,
              ...skillClientArgs(config),
              "-e",
              `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
              "-e",
              `ANTNEST_E2E_SESSION_ID=${result.session_id}`,
              "-e",
              `ANTNEST_E2E_FAILED_SOURCE_RUN_ID=${before.source_run_id}`,
              ...(reviewBrowser
                ? ["-e", "ANTNEST_E2E_DIAGNOSTIC_ALREADY_READ=true"]
                : []),
              "-v",
              `${root}/tests:/app/tests:ro`,
              image,
              "node",
              "/app/tests/e2e/skill-learning/model-recovery-client.mjs",
            ],
            true,
          );
        } catch (error) {
          const clientLog = spawnSync(
            "docker",
            ["logs", "--tail", "200", recoveryClientName],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 10_000,
            },
          );
          await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
          await writeFile(
            `${evidenceDir}${config.project}.model-recovery-client-failure.json`,
            JSON.stringify({
              before,
              clientLog: `${clientLog.stdout ?? ""}\n${clientLog.stderr ?? ""}`,
            }),
            { flag: "wx", mode: 0o600 },
          );
          throw new Error(
            `Learning after model recovery failed: ${clientLog.stderr ?? ""}`,
            { cause: error },
          );
        }
        modelRecovery = JSON.parse(recovered.trim().split("\n").at(-1));
        assert.equal(modelRecovery.status, "learning_after_model_recovery");
        assert.deepEqual(
          await failedReceipt(),
          before,
          "the unknown call and its reserved cost remain intact",
        );
        const recoveredTasks = await sql(
          `SELECT state,COALESCE(pause_reason,''),model_calls FROM learning_tasks
           WHERE agent_id='${fixture.agentID}' ORDER BY created_at`,
        );
        assert.equal(
          recoveredTasks.trim(),
          "paused|runtime_unavailable|1\ncompleted||1",
        );
        const recoveredChanges = await sql(
          `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
        );
        assert.equal(recoveredChanges.trim(), "1");
        modelRecovery.failedReceipt = before;
        modelRecovery.tasks = recoveredTasks.trim();
        modelRecovery.changes = recoveredChanges.trim();
        if (learningBrowser)
          modelRecovery.browser =
            await learningBrowser.verifyRecovered(modelRecovery);
      }
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      await writeFile(
        `${evidenceDir}${config.project}.${scenario}.json`,
        JSON.stringify({
          ...result,
          tasks,
          changes,
          ...(modelCallState ? { modelCallState } : {}),
          ...(lifecycleModel ? { lifecycleModel } : {}),
          ...(restartedForeground ? { restartedForeground } : {}),
          ...(modelRecovery ? { modelRecovery } : {}),
        }),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    } finally {
      try {
        await learningBrowser?.close();
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        if (config) await cleanup(config);
      }
    }
  },
);
