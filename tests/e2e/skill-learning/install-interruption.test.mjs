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
import { runtimeStatus } from "../lifecycle-closeout/runtime-status.mjs";
import { setup, until } from "../workspace-closeout/c4-setup.mjs";
import { learningImageOverlay } from "./development-settings.mjs";
import { skillClientArgs } from "./client-container.mjs";

// Each scenario interrupts the first idle install of a learned Skill once and
// checks the contract: lifecycle and foreground work never wait for learning,
// the candidate survives, and the identical install resent later records the
// change exactly once without renaming the active package a second time.
const scenarios = {
  // The Runtime installed the Skill; ACP is still waiting for the receipt.
  "held-disable": { gate: "response", stop: "disable" },
  "held-foreground": { gate: "response", stop: "foreground" },
  // ACP recorded the attempt; the Runtime has not seen it.
  "pre-dispatch-disable": { gate: "dispatch", stop: "disable" },
  // The Runtime renamed the package and is paused before it replies.
  "after-rename-disable": { gate: "observe", stop: "disable", runtime: true },
  "after-rename-foreground": {
    gate: "observe",
    stop: "foreground",
    runtime: true,
  },
  // The receipt is lost with no lifecycle or foreground involvement.
  lost: { gate: "response", stop: "lost" },
};
const name = process.env.ANTNEST_E2E_INSTALL_INTERRUPTION;
assert(
  Object.hasOwn(scenarios, name),
  `ANTNEST_E2E_INSTALL_INTERRUPTION must be one of ${Object.keys(scenarios).join(", ")}`,
);
const scenario = scenarios[name];
const installed = scenario.gate !== "dispatch";
// ACP never sees a receipt for a request the gate held; only the Runtime can
// still answer a paused install, and then only with `preempted`.
const interruptedAttempt = scenario.runtime
  ? /^(?:unknown\||settled\|preempted)$/u
  : /^unknown\|$/u;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const overlay = [
  "-f",
  "tests/e2e/workspace-closeout/c4.compose.yaml",
  ...learningImageOverlay,
  "-f",
  "tests/e2e/skill-learning/compose.yaml",
  "-f",
  "tests/e2e/skill-learning/install-gate.compose.yaml",
];
const evidenceDir = fileURLToPath(
  new URL("../../../artifacts/verification/skill-learning/", import.meta.url),
);
const skillRoot = "/workspace/.antnest/skills/fixture-procedure";
const runtimeGate = "/workspace/.antnest/skill-learning/e2e-install-gate";
const learnedRule =
  "For the fixture task, inspect the target before editing it.";

const titles = {
  "held-disable":
    "Agent Disable completes while ACP waits for an installed Skill receipt; Enable settles the resend once",
  "held-foreground":
    "a foreground Run completes while ACP waits for an installed Skill receipt; the idle resend settles once",
  "pre-dispatch-disable":
    "Agent Disable abandons an undispatched Skill install; Enable installs the kept candidate once",
  "after-rename-disable":
    "Agent Disable preempts a Runtime paused after the Skill rename; Enable settles the resend once",
  "after-rename-foreground":
    "a foreground Run preempts a Runtime paused after the Skill rename; the idle resend settles once",
  lost: "a lost Skill install receipt is resent and settles as applied without a second rename",
};

test(titles[name], { timeout: 720_000 }, async (t) => {
  process.chdir(root);
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Skill install interruption E2E interrupted"));
  t.signal.addEventListener("abort", interrupt, { once: true });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let config;
  const ownedImages = [];
  try {
    config = await configuration(abort.signal);
    const keys = generateKeyPairSync("ed25519");
    const rawPublic = keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    const image = `antnest/agent-acp-service:skill-learning-${config.project.slice(-8)}`;
    const ownership = `io.antnest.verification.project=${config.project}`;
    const build = dockerClient(config.env, abort.signal, 720_000);
    const absent = async (tag) => {
      const existing = await build([
        "image",
        "ls",
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]);
      assert(
        !existing.split(/\s+/u).includes(tag),
        "candidate tag already exists",
      );
      ownedImages.push(tag);
    };
    if (scenario.runtime) {
      const runtimeImage = `antnest/antnest-runtime:skill-learning-gate-${config.project.slice(-8)}`;
      await absent(runtimeImage);
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
      // Runtime Controller's image policy admits repositories, never bare
      // image IDs; the ID stays the physical identity to compare against.
      config.image = runtimeImage;
      config.resolvedImage = gatedImage.Id;
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
      ANTNEST_E2E_INSTALL_GATE: scenario.gate,
      ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: "false",
      ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "",
    });
    const docker = dockerClient(config.env, abort.signal, 720_000);
    await absent(image);
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
    const runtimeName = `antnest-runtime-${fixture.agentID}`;
    const workspaceVolume = `antnest-workspace-${fixture.agentID}`;
    const service = async (serviceName) =>
      docker(
        composeArgs(config.project, [...overlay, "ps", "-q", serviceName]),
      );
    const acpContainer = await service("agent-acp-service");
    const postgres = await service("postgres");
    const modelContainer = await service("stage3-model");
    const sql = async (query) =>
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
          query,
        ])
      ).trim();
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
    // Reads the retained workspace volume whether or not a Runtime is running.
    const workspace = async (script, mode = "ro") =>
      JSON.parse(
        await docker([
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          "1000:1000",
          "-v",
          `${workspaceVolume}:/workspace:${mode}`,
          "-e",
          "NODE_OPTIONS=",
          image,
          "node",
          "-e",
          script,
        ]),
      );
    const active = () =>
      workspace(
        `const fs=require('node:fs');const p='${skillRoot}';console.log(JSON.stringify(fs.existsSync(p+'/SKILL.md')?{inode:fs.statSync(p).ino,text:fs.readFileSync(p+'/SKILL.md','utf8')}:null))`,
      );
    const learning = async () => ({
      task: await sql(
        `SELECT state||'|'||COALESCE(pause_reason,'') FROM learning_tasks WHERE agent_id='${fixture.agentID}'`,
      ),
      changes: Number(
        await sql(
          `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
        ),
      ),
      installs: (
        await sql(
          `SELECT intent.state||'|'||COALESCE(intent.receipt->>'outcome','') FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='install' ORDER BY intent.created_at`,
        )
      )
        .split("\n")
        .filter(Boolean),
      retired: Number(
        await sql(
          `SELECT count(*) FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action<>'install'`,
        ),
      ),
    });
    const client = async (label, script, env = []) => {
      const clientName = `${config.project}-skill-install-${label}`;
      const started = Date.now();
      try {
        const output = await docker(
          [
            "run",
            "--name",
            clientName,
            ...skillClientArgs(config),
            "-e",
            `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
            ...env.flatMap((value) => ["-e", value]),
            "-v",
            `${root}/tests:/app/tests:ro`,
            image,
            "node",
            `/app/tests/e2e/skill-learning/${script}`,
          ],
          true,
        );
        return {
          ...JSON.parse(output.trim().split("\n").at(-1)),
          elapsedMs: Date.now() - started,
        };
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
          `${label} client failed with learning state ${JSON.stringify(await learning().catch(() => null))}: ${logs.stdout ?? ""}\n${logs.stderr ?? ""}`,
          { cause: error },
        );
      } finally {
        await docker(["rm", "-f", clientName]).catch(() => undefined);
      }
    };

    if (scenario.runtime) {
      const status = await runtimeStatus(docker, config.project, runtimeName);
      assert.deepEqual(status.test_features, ["skill-maintenance-e2e-gate"]);
      const logs = spawnSync("docker", ["logs", runtimeName], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
      assert.deepEqual(warnings[0].test_features, status.test_features);
      await docker([
        "exec",
        "-u",
        "1000:1000",
        runtimeName,
        "sh",
        "-c",
        `mkdir -p ${runtimeGate} && touch ${runtimeGate}/hold`,
      ]);
    }
    const beforeRuntime = JSON.parse(await docker(["inspect", runtimeName]))[0]
      .Id;
    const beforeExecutionState = await fixture.state();

    const pending = await client("source", "preempt-client.mjs", [
      "ANTNEST_E2E_STOP_AFTER_PENDING=true",
      "ANTNEST_E2E_HELD_INSTALL=true",
    ]);
    assert.equal(pending.status, "review_pending_for_install");
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
        if (!scenario.runtime) return (await gate("status")).pending || null;
        const entered = await docker([
          "exec",
          runtimeName,
          "sh",
          "-c",
          `test -e ${runtimeGate}/entered && echo yes || echo no`,
        ]);
        return entered.trim() === "yes" || null;
      },
      scenario.runtime
        ? "Runtime paused after the Skill rename"
        : "first Skill install held at ACP",
      abort.signal,
      60_000,
    );
    const interrupted = await learning();
    assert.equal(interrupted.changes, 0);
    assert.equal(
      interrupted.retired,
      0,
      "ACP sent a retired maintenance action",
    );
    const installedPackage = await active();
    if (installed) {
      assert(installedPackage?.text.includes(learnedRule));
    } else {
      assert.equal(installedPackage, null);
    }

    const evidence = { scenario: name, agentId: fixture.agentID };
    if (scenario.stop === "lost") {
      assert.deepEqual(await gate("drop", "POST"), { dropped: true });
    } else if (scenario.stop === "foreground") {
      // Nothing is released: the Run can complete only if neither ACP nor the
      // Runtime waits for the interrupted install.
      const foreground = await client("foreground", "post-enable-client.mjs");
      assert.equal(foreground.status, "foreground_completed_after_enable");
      evidence.foregroundMs = foreground.elapsedMs;
      const status = await gate("status");
      assert.equal(status.pending, false);
      assert.equal(
        status.aborted,
        true,
        "foreground admission keeps the install",
      );
    } else {
      const accepted = await fixture.json(
        `/api/admin/agents/${fixture.agentID}/disable`,
        {
          status: 202,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        },
      );
      const operationId = (accepted.operation ?? accepted).request_id;
      const disableStarted = Date.now();
      await fixture.operation(operationId);
      evidence.disableMs = Date.now() - disableStarted;
      const status = await gate("status");
      assert.equal(status.pending, false);
      assert.equal(status.aborted, true, "Disable keeps the install in flight");
      const closed = await until(
        async () => {
          const state = await learning();
          return state.task === "paused|lifecycle_closed" ? state : null;
        },
        "learning task paused by the lifecycle",
        abort.signal,
        30_000,
      );
      assert.equal(closed.changes, 0);
      assert.equal(closed.installs.length, 1);
      assert.match(closed.installs[0], interruptedAttempt);
      assert.deepEqual(await active(), installedPackage);
      evidence.closed = closed;
      if (scenario.runtime)
        await workspace(
          `require('node:fs').rmSync('${runtimeGate}',{recursive:true,force:true});console.log('{}')`,
          "rw",
        );
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
      const afterRuntime = JSON.parse(await docker(["inspect", runtimeName]))[0]
        .Id;
      assert(
        afterRuntime && afterRuntime !== beforeRuntime,
        "Enable must install a distinct Runtime execution",
      );
      await until(
        async () => {
          const state = await fixture.state();
          return state !== null &&
            state.configuration_revision !==
              beforeExecutionState.configuration_revision
            ? state
            : null;
        },
        "ACP publishes the replacement Runtime execution",
        abort.signal,
        30_000,
      );
    }
    if (scenario.runtime && scenario.stop === "foreground")
      await docker([
        "exec",
        "-u",
        "1000:1000",
        runtimeName,
        "rm",
        "-rf",
        runtimeGate,
      ]);

    const settled = await until(
      async () => {
        const state = await learning();
        return state.task === "completed|" && state.changes === 1
          ? state
          : null;
      },
      "resent install records the learned Skill",
      abort.signal,
      60_000,
    );
    assert.equal(settled.retired, 0, "ACP sent a retired maintenance action");
    assert(settled.installs.length >= 2, "the interrupted install was resent");
    assert.equal(settled.installs.at(-1), "settled|applied");
    assert.match(settled.installs[0], interruptedAttempt);
    assert.equal(
      settled.installs.filter((row) => row === "settled|applied").length,
      1,
    );
    const gateStatus = await gate("status");
    assert.equal(gateStatus.installs, settled.installs.length);
    const finalPackage = await active();
    assert(finalPackage?.text.includes(learnedRule));
    if (installed)
      assert.equal(
        finalPackage.inode,
        installedPackage.inode,
        "the resend renamed the active package again",
      );
    evidence.settled = settled;
    evidence.sameActivePackage = installed;

    if (scenario.stop !== "foreground") {
      const foreground = await client("after", "post-enable-client.mjs");
      assert.equal(foreground.status, "foreground_completed_after_enable");
    }
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      `${evidenceDir}${config.project}.install-${name}.json`,
      JSON.stringify(evidence),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    try {
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
        for (const tag of ownedImages.filter((tag) => existing.includes(tag))) {
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
});
