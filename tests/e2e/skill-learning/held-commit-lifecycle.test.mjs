import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { setup, until } from "../workspace-closeout/c4-setup.mjs";
import { learningImageOverlay } from "./development-settings.mjs";
import { skillClientArgs } from "./client-container.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dropResponse = process.env.ANTNEST_E2E_DROP_COMMIT_RESPONSE === "true";
const holdBeforeDispatch =
  process.env.ANTNEST_E2E_HOLD_BEFORE_COMMIT === "true";
const holdAfterInstall = process.env.ANTNEST_E2E_HOLD_AFTER_INSTALL === "true";
const foregroundDuringCommit =
  process.env.ANTNEST_E2E_FOREGROUND_DURING_COMMIT === "true";
const foregroundDuringAtomic =
  process.env.ANTNEST_E2E_FOREGROUND_DURING_ATOMIC_COMMIT === "true";
const atomicHold = holdAfterInstall || foregroundDuringAtomic;
assert(
  [
    dropResponse,
    holdBeforeDispatch,
    holdAfterInstall,
    foregroundDuringCommit,
    foregroundDuringAtomic,
  ].filter(Boolean).length <= 1,
);
const overlay = [
  "-f",
  "tests/e2e/workspace-closeout/c4.compose.yaml",
  ...learningImageOverlay,
  "-f",
  "tests/e2e/skill-learning/compose.yaml",
  "-f",
  "tests/e2e/skill-learning/held-commit.compose.yaml",
];
const evidenceDir = fileURLToPath(
  new URL("../../../artifacts/verification/skill-learning/", import.meta.url),
);

test(
  holdBeforeDispatch
    ? "Agent Disable settles a Skill commit cancelled before Runtime dispatch"
    : holdAfterInstall
      ? "Agent Disable waits while Runtime finalizes an installed Skill"
      : foregroundDuringCommit
        ? "foreground Run waits for a held Skill commit receipt and then completes"
        : foregroundDuringAtomic
          ? "foreground Run is fenced during atomic Skill commit and succeeds after effect recovery"
          : dropResponse
            ? "Agent Disable fences a lost Runtime Skill commit receipt"
            : "Agent Disable waits for a real Runtime Skill commit receipt",
  { timeout: 720_000 },
  async (t) => {
    process.chdir(root);
    const abort = new AbortController();
    const interrupt = () =>
      abort.abort(new Error("Held Skill commit E2E interrupted"));
    t.signal.addEventListener("abort", interrupt, { once: true });
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let config;
    let settleGate;
    const ownedImages = [];
    try {
      config = await configuration(abort.signal);
      const keys = generateKeyPairSync("ed25519");
      const rawPublic = keys.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      const image = `antnest/agent-acp-service:skill-learning-${config.project.slice(-8)}`;
      const ownership = `io.antnest.verification.project=${config.project}`;
      if (atomicHold) {
        const runtimeImage = `antnest/antnest-runtime:skill-learning-gate-${config.project.slice(-8)}`;
        const build = dockerClient(config.env, abort.signal, 720_000);
        const existing = await build([
          "image",
          "ls",
          "--format",
          "{{.Repository}}:{{.Tag}}",
        ]);
        assert(
          !existing.split(/\s+/u).includes(runtimeImage),
          "candidate tag already exists",
        );
        ownedImages.push(runtimeImage);
        await build(
          [
            "build",
            "-f",
            "runtimes/antnest-runtime/Dockerfile",
            "--target",
            "e2e",
            "--build-arg",
            "ANTNEST_RUNTIME_FEATURES=skill-maintenance-e2e-gate",
            "--label",
            ownership,
            "-t",
            runtimeImage,
            ".",
          ],
          true,
        );
        const [gatedImage] = JSON.parse(
          await build(["image", "inspect", runtimeImage]),
        );
        assert.equal(
          gatedImage.Config.Labels["dev.antnest.runtime.test-features"],
          "skill-maintenance-e2e-gate",
        );
        assert(
          gatedImage.Config.Env.includes(
            "ANTNEST_RUNTIME_ALLOW_TEST_FEATURES=true",
          ),
        );
        config.image = gatedImage.Id;
        config.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF = config.image;
      }
      Object.assign(config.env, {
        ANTNEST_C4_AGENT_ACP_IMAGE: image,
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
        ANTNEST_E2E_HOLD_REVIEW: "true",
        ANTNEST_E2E_REVIEW_SKIP: "false",
        ANTNEST_E2E_REVIEW_FAILURE: "false",
        ANTNEST_E2E_HOLD_BEFORE_COMMIT: String(holdBeforeDispatch),
        ANTNEST_E2E_HOLD_AFTER_INSTALL: String(atomicHold),
        ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: "false",
        ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "",
      });
      const docker = dockerClient(config.env, abort.signal, 720_000);
      const existing = await docker([
        "image",
        "ls",
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]);
      assert(
        !existing.split(/\s+/u).includes(image),
        "candidate tag already exists",
      );
      ownedImages.push(image);
      await docker(
        [
          "build",
          "-f",
          "services/agent-acp-service/Dockerfile",
          "--label",
          ownership,
          "-t",
          image,
          ".",
        ],
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
      if (atomicHold) {
        const runtimeStatus = JSON.parse(
          await docker([
            "exec",
            `antnest-runtime-${fixture.agentID}`,
            "curl",
            "--fail",
            "--silent",
            "http://127.0.0.1:8093/status",
          ]),
        );
        assert.deepEqual(runtimeStatus.test_features, [
          "skill-maintenance-e2e-gate",
        ]);
        const logs = spawnSync(
          "docker",
          ["logs", `antnest-runtime-${fixture.agentID}`],
          {
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        assert.equal(logs.status, 0);
        const warnings = `${logs.stdout}${logs.stderr}`
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line))
          .filter(
            (event) => event["lifecycle.event"] === "test_features_enabled",
          );
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].level, "WARN");
        assert.deepEqual(
          warnings[0].test_features,
          runtimeStatus.test_features,
        );
        await docker([
          "exec",
          "-u",
          "1000:1000",
          `antnest-runtime-${fixture.agentID}`,
          "mkdir",
          "-p",
          "/workspace/.antnest/skill-learning/e2e-commit-gate",
        ]);
        await docker([
          "exec",
          "-u",
          "1000:1000",
          `antnest-runtime-${fixture.agentID}`,
          "touch",
          "/workspace/.antnest/skill-learning/e2e-commit-gate/hold",
        ]);
      }
      const beforeRuntime =
        holdBeforeDispatch || atomicHold
          ? JSON.parse(
              await docker(["inspect", `antnest-runtime-${fixture.agentID}`]),
            )[0].Id
          : null;
      const beforeExecutionState =
        holdBeforeDispatch || atomicHold ? await fixture.state() : null;
      const clientName = `${config.project}-skill-learning-held-client`;
      let clientOutput;
      try {
        clientOutput = await docker(
          [
            "run",
            "--name",
            clientName,
            ...skillClientArgs(config),
            "-e",
            `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
            "-e",
            "ANTNEST_E2E_STOP_AFTER_PENDING=true",
            "-e",
            "ANTNEST_E2E_HELD_COMMIT_DISABLE=true",
            "-v",
            `${root}/tests:/app/tests:ro`,
            image,
            "node",
            "/app/tests/e2e/skill-learning/preempt-client.mjs",
          ],
          true,
        );
      } catch (error) {
        const logs = spawnSync(
          "docker",
          ["logs", "--tail", "120", clientName],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          },
        );
        throw new Error(
          `Held-commit source client failed: ${logs.stdout ?? ""}\n${logs.stderr ?? ""}`,
          {
            cause: error,
          },
        );
      }
      const client = JSON.parse(clientOutput.trim().split("\n").at(-1));
      assert.equal(client.status, "review_pending_for_commit");

      const modelContainer = await docker(
        composeArgs(config.project, [...overlay, "ps", "-q", "stage3-model"]),
      );
      const acpContainer = await docker(
        composeArgs(config.project, [
          ...overlay,
          "ps",
          "-q",
          "agent-acp-service",
        ]),
      );
      const gate = async (path, method = "GET") =>
        JSON.parse(
          await docker([
            "exec",
            "-e",
            "NODE_OPTIONS=",
            acpContainer,
            "node",
            "-e",
            `fetch('http://127.0.0.1:18093/${path}',{method:'${method}'}).then(r=>r.text()).then(console.log)`,
          ]),
        );
      const runtimeName = `antnest-runtime-${fixture.agentID}`;
      settleGate = atomicHold
        ? async () => {
            await docker([
              "exec",
              "-u",
              "1000:1000",
              runtimeName,
              "touch",
              "/workspace/.antnest/skill-learning/e2e-commit-gate/release",
            ]);
            return { released: true };
          }
        : () => gate(dropResponse ? "drop" : "release", "POST");
      const releasedReview = JSON.parse(
        await docker([
          "exec",
          modelContainer,
          "node",
          "-e",
          "fetch('http://127.0.0.1:8080/release-review',{method:'POST'}).then(r=>r.text()).then(console.log)",
        ]),
      );
      assert.equal(releasedReview.released, "review-create");
      await until(
        async () => {
          if (!atomicHold) return (await gate("status")).pending || null;
          const entered = await docker([
            "exec",
            runtimeName,
            "node",
            "-e",
            "console.log(require('node:fs').existsSync('/workspace/.antnest/skill-learning/e2e-commit-gate/entered'))",
          ]);
          return entered.trim() === "true" || null;
        },
        atomicHold
          ? "Runtime paused after atomic Skill install"
          : "real Runtime commit receipt held at ACP",
        abort.signal,
        60_000,
      );
      if (!holdBeforeDispatch) {
        const activeSkill = await docker([
          "exec",
          `antnest-runtime-${fixture.agentID}`,
          "cat",
          "/workspace/.antnest/skills/fixture-procedure/SKILL.md",
        ]);
        assert(
          activeSkill.includes(
            "For the fixture task, inspect the target before editing it.",
          ),
        );
      }
      if (foregroundDuringCommit || foregroundDuringAtomic) {
        const foregroundName = `${config.project}-skill-learning-foreground-during-commit`;
        try {
          await docker([
            "run",
            "-d",
            "--name",
            foregroundName,
            ...skillClientArgs(config),
            "-e",
            `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
            "-v",
            `${root}/tests:/app/tests:ro`,
            image,
            "node",
            "/app/tests/e2e/skill-learning/post-enable-client.mjs",
          ]);
          await until(
            async () => (await gate("status")).aborted || null,
            "foreground admission cancels held maintenance request",
            abort.signal,
            8_000,
          );
          const foregroundRunning = await docker([
            "inspect",
            "--format",
            "{{.State.Running}}",
            foregroundName,
          ]);
          if (foregroundDuringAtomic) {
            assert.equal(foregroundRunning, "false");
            const foregroundLog = spawnSync(
              "docker",
              ["logs", "--tail", "30", foregroundName],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 10_000,
              },
            );
            const exitCode = await docker([
              "inspect",
              "--format",
              "{{.State.ExitCode}}",
              foregroundName,
            ]);
            assert.equal(exitCode, "1");
            assert.match(
              foregroundLog.stderr ?? "",
              /runtime_barrier_required/,
            );
          } else {
            assert.equal(foregroundRunning, "true");
          }
          assert.deepEqual(await settleGate(), { released: true });
          settleGate = undefined;
          if (!foregroundDuringAtomic) {
            assert.equal(await docker(["wait", foregroundName]), "0");
            const foregroundLog = await docker(["logs", foregroundName]);
            assert.equal(
              JSON.parse(foregroundLog.trim().split("\n").at(-1)).status,
              "foreground_completed_after_enable",
            );
          }
          const postgres = await docker(
            composeArgs(config.project, [...overlay, "ps", "-q", "postgres"]),
          );
          const query = async (sql) =>
            (
              await docker([
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
                sql,
              ])
            ).trim();
          if (foregroundDuringAtomic) {
            try {
              await until(
                async () => {
                  const task = await query(
                    `SELECT state FROM learning_tasks WHERE agent_id='${fixture.agentID}'`,
                  );
                  const changes = await query(
                    `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
                  );
                  return task === "completed" && changes === "1" ? true : null;
                },
                "atomic Skill effect observed and applied once",
                abort.signal,
                45_000,
              );
            } catch (error) {
              const task = await query(
                `SELECT state,COALESCE(pause_reason,'') FROM learning_tasks WHERE agent_id='${fixture.agentID}'`,
              );
              const changes = await query(
                `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
              );
              const intents = await query(
                `SELECT intent.action,intent.state,COALESCE(intent.receipt->>'outcome','') FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' ORDER BY intent.created_at`,
              );
              throw new Error(
                `Atomic foreground recovery stalled: ${JSON.stringify({ task, changes, intents })}`,
                { cause: error },
              );
            }
            const retryName = `${foregroundName}-retry`;
            try {
              await docker([
                "run",
                "--name",
                retryName,
                ...skillClientArgs(config),
                "-e",
                `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
                "-v",
                `${root}/tests:/app/tests:ro`,
                image,
                "node",
                "/app/tests/e2e/skill-learning/post-enable-client.mjs",
              ]);
              const retryLog = await docker(["logs", retryName]);
              assert.equal(
                JSON.parse(retryLog.trim().split("\n").at(-1)).status,
                "foreground_completed_after_enable",
              );
            } finally {
              await docker(["rm", "-f", retryName]).catch(() => undefined);
            }
          }
          assert.equal(
            await query(
              `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
            ),
            "1",
          );
          assert.equal(
            await query(
              `SELECT count(*) FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='commit'`,
            ),
            "1",
          );
          await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
          await writeFile(
            `${evidenceDir}${config.project}.${foregroundDuringAtomic ? "foreground-atomic" : "foreground-held"}-commit.json`,
            JSON.stringify({
              agentId: fixture.agentID,
              initiallyFenced: foregroundDuringAtomic,
              foregroundCompleted: true,
              changeCount: 1,
              commitCount: 1,
            }),
            { flag: "wx", mode: 0o600 },
          );
        } finally {
          await docker(["rm", "-f", foregroundName]).catch(() => undefined);
        }
        return;
      }
      const accepted = await fixture.json(
        `/api/admin/agents/${fixture.agentID}/disable`,
        {
          status: 202,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        },
      );
      const operationId = (accepted.operation ?? accepted).request_id;
      if (!holdAfterInstall)
        await until(
          async () => (await gate("status")).aborted || null,
          "lifecycle cancelled held maintenance request",
          abort.signal,
          8_000,
        );
      const beforeRelease = await fixture.json(
        `/api/admin/operations/${operationId}`,
      );
      assert.notEqual(beforeRelease.state, "completed");
      assert.deepEqual(
        await settleGate(),
        dropResponse ? { dropped: true } : { released: true },
      );
      settleGate = undefined;
      await fixture.operation(operationId);

      const postgres = await docker(
        composeArgs(config.project, [...overlay, "ps", "-q", "postgres"]),
      );
      const sql = (query) =>
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
      const tasks = (
        await sql(
          `SELECT state,COALESCE(pause_reason,''),model_calls FROM learning_tasks WHERE agent_id='${fixture.agentID}'`,
        )
      ).trim();
      const changes = (
        await sql(
          `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
        )
      ).trim();
      const commitIntent = (
        await sql(
          `SELECT intent.state,COALESCE(intent.receipt->>'kind',''),COALESCE(intent.receipt->>'outcome','') FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='commit'`,
        )
      ).trim();
      const intentCounts = (
        await sql(
          `SELECT action,count(*) FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND action IN ('commit','observe') GROUP BY action ORDER BY action`,
        )
      ).trim();
      if (holdAfterInstall)
        console.log(
          JSON.stringify({ tasks, changes, commitIntent, intentCounts }),
        );
      assert.equal(
        tasks,
        holdBeforeDispatch || holdAfterInstall
          ? "paused|lifecycle_closed|1"
          : "completed||1",
      );
      assert.equal(changes, holdBeforeDispatch || holdAfterInstall ? "0" : "1");
      if (holdBeforeDispatch || holdAfterInstall) {
        const workspaceVolume = `antnest-workspace-${fixture.agentID}`;
        await docker(["volume", "inspect", workspaceVolume]);
        const activeExists = await docker([
          "run",
          "--rm",
          "--network",
          "none",
          "-v",
          `${workspaceVolume}:/workspace:ro`,
          image,
          "node",
          "-e",
          "console.log(require('node:fs').existsSync('/workspace/.antnest/skills/fixture-procedure/SKILL.md'))",
        ]);
        assert.equal(activeExists.trim(), holdAfterInstall ? "true" : "false");
      }
      assert.equal(
        commitIntent,
        holdBeforeDispatch || holdAfterInstall
          ? "unknown||"
          : dropResponse
            ? "settled|observed_effect|applied"
            : "settled||applied",
      );
      assert.equal(
        intentCounts,
        holdBeforeDispatch || holdAfterInstall || dropResponse
          ? "commit|1\nobserve|1"
          : "commit|1",
      );
      let recoveredAfterEnable = null;
      if (holdBeforeDispatch || holdAfterInstall) {
        const enabled = await fixture.json(
          `/api/admin/agents/${fixture.agentID}/enable`,
          {
            status: 202,
            headers: { "Idempotency-Key": randomUUID() },
            body: {},
          },
        );
        await fixture.operation((enabled.operation ?? enabled).request_id);
        await fixture.ready();
        const afterRuntime = JSON.parse(
          await docker(["inspect", `antnest-runtime-${fixture.agentID}`]),
        )[0].Id;
        assert(
          afterRuntime && afterRuntime !== beforeRuntime,
          "Enable must install a distinct Runtime execution",
        );
        let afterExecutionState;
        await until(
          async () => {
            afterExecutionState = await fixture.state();
            return afterExecutionState !== null &&
              afterExecutionState.configuration_revision !==
                beforeExecutionState.configuration_revision
              ? afterExecutionState
              : null;
          },
          "ACP publishes the replacement Runtime execution",
          abort.signal,
          30_000,
        );
        if (holdAfterInstall) {
          recoveredAfterEnable = await until(
            async () => {
              const row = (
                await sql(
                  `SELECT state,COALESCE(pause_reason,'') FROM learning_tasks WHERE agent_id='${fixture.agentID}'`,
                )
              ).trim();
              const changeCount = (
                await sql(
                  `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
                )
              ).trim();
              return row === "completed|" && changeCount === "1"
                ? { row, changeCount }
                : null;
            },
            "replacement Runtime observes installed Skill and records learning",
            abort.signal,
            45_000,
          );
          assert.equal(
            (
              await sql(
                `SELECT intent.state,COALESCE(intent.receipt->>'kind',''),COALESCE(intent.receipt->>'outcome','') FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='commit'`,
              )
            ).trim(),
            "settled|observed_effect|applied",
          );
          assert.equal(
            (
              await sql(
                `SELECT count(*) FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='commit'`,
              )
            ).trim(),
            "1",
          );
          assert.equal(
            (
              await sql(
                `SELECT intent.state,count(*) FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='observe' GROUP BY intent.state ORDER BY intent.state`,
              )
            ).trim(),
            "settled|1\nunknown|1",
          );
        }
        const postEnableClient = `${config.project}-skill-learning-post-enable-client`;
        let result;
        try {
          result = await docker([
            "run",
            "--name",
            postEnableClient,
            ...skillClientArgs(config),
            "-e",
            `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
            "-v",
            `${root}/tests:/app/tests:ro`,
            image,
            "node",
            "/app/tests/e2e/skill-learning/post-enable-client.mjs",
          ]);
        } catch (error) {
          const logs = spawnSync(
            "docker",
            ["logs", "--tail", "40", postEnableClient],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 10_000,
            },
          );
          throw new Error(
            `Post-enable foreground failed after state ${JSON.stringify(afterExecutionState)}: ${logs.stdout ?? ""}\n${logs.stderr ?? ""}`,
            { cause: error },
          );
        } finally {
          await docker(["rm", "-f", postEnableClient]).catch(() => undefined);
        }
        assert.equal(
          JSON.parse(result.trim().split("\n").at(-1)).status,
          "foreground_completed_after_enable",
        );
      }
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      await writeFile(
        `${evidenceDir}${config.project}.${holdAfterInstall ? "atomic" : holdBeforeDispatch ? "pre-dispatch" : dropResponse ? "lost" : "held"}-commit-disable.json`,
        JSON.stringify({
          agentId: fixture.agentID,
          activeSkillReadBeforeDisable: !holdBeforeDispatch,
          foregroundCompletedAfterEnable:
            holdBeforeDispatch || holdAfterInstall,
          recoveredAfterEnable,
          beforeRelease: beforeRelease.state,
          tasks,
          changes,
          commitIntent,
          intentCounts,
        }),
        { flag: "wx", mode: 0o600 },
      );
    } finally {
      try {
        if (settleGate) await settleGate().catch(() => undefined);
        if (config) await cleanup(config);
        if (config && ownedImages.length) {
          const cleanImages = dockerClient(config.env, undefined, 120_000);
          const existing = (
            await cleanImages([
              "image",
              "ls",
              "--format",
              "{{.Repository}}:{{.Tag}}",
            ])
          ).split(/\s+/u);
          for (const tag of ownedImages.filter((tag) =>
            existing.includes(tag),
          )) {
            const [candidate] = JSON.parse(
              await cleanImages(["image", "inspect", tag]),
            );
            assert.equal(
              candidate.Config.Labels["io.antnest.verification.project"],
              config.project,
            );
            await cleanImages(["image", "rm", tag]);
          }
        }
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        t.signal.removeEventListener("abort", interrupt);
      }
    }
  },
);
