import { isolateCompromisedRuntime } from "./key-compromise-recovery.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
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
import { runNetworkMatrix } from "../security/network-flow.mjs";
import { runAuthenticatedPeer } from "../security/authenticated-flow.mjs";
import { collectLearningTraces } from "./learning-trace.mjs";
import { collectDiscoveryTrace } from "./discovery-trace.mjs";
import { temporaryAcpFlow } from "./temporary-acp-flow.mjs";
import { callerAcpFlow } from "./caller-flow.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { assertReleasedSkillSurface } from "../skill-registry/release-surface.mjs";
import { assertMaintenanceKidStartupRejected } from "./maintenance-kid.mjs";
import {
  learningImageOverlay,
  assertLearningDebugWarning,
  assertStandardComposeIgnoresDebugSettings,
} from "./development-settings.mjs";
import { rotatePlatformKeys } from "../encryption-key-rotation/flow.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const debugLearning = process.env.ANTNEST_E2E_SKILL_LEARNING_DEBUG === "true";
const toolUsability = process.env.ANTNEST_E2E_TOOL_USABILITY === "true";
const discovery = process.env.ANTNEST_E2E_SKILL_DISCOVERY === "true";
const discoveryTools = process.env.ANTNEST_E2E_SKILL_DISCOVERY_TOOLS === "true";
const temporaryTools = process.env.ANTNEST_E2E_SKILL_TEMPORARY === "true";
const propagation = process.env.ANTNEST_E2E_SKILL_PROPAGATION === "true";
const deployment = process.env.ANTNEST_E2E_SKILL_DEPLOYMENT === "true";
const authenticationIntegration =
  process.env.ANTNEST_E2E_SERVICE_AUTHENTICATION === "true";
const encryptionKeyRotation =
  process.env.ANTNEST_E2E_ENCRYPTION_KEY_ROTATION === "true";
assert(!authenticationIntegration || deployment);
assert(!encryptionKeyRotation || authenticationIntegration);
const signingKid = deployment ? "key_2026-01" : "fixture-key";
const sourceLifecycle =
  process.env.ANTNEST_E2E_SKILL_SOURCE_LIFECYCLE === "true";
const callerDiscovery = process.env.ANTNEST_E2E_SKILL_CALLER === "true";
assert(!sourceLifecycle || deployment);
assert(!callerDiscovery || (deployment && !sourceLifecycle));
assert(!deployment || propagation);
assert(!propagation || temporaryTools);
assert(!temporaryTools || discoveryTools);
assert(!discoveryTools || discovery);
assert(!toolUsability || debugLearning);
const verifyLearningTrace =
  propagation ||
  debugLearning ||
  process.env.ANTNEST_E2E_LEARNING_TRACE === "true";
const uiOutage = process.env.ANTNEST_E2E_UI_OUTAGE === "true";
const browserAcceptance = process.env.ANTNEST_E2E_SKILL_BROWSER === "true";
const noticeFailure = process.env.ANTNEST_E2E_NOTICE_SEND_FAILURE === "true";
const keyCompromise = process.env.ANTNEST_E2E_SKILL_KEY_COMPROMISE === "true";
const keyRotation =
  keyCompromise || process.env.ANTNEST_E2E_SKILL_KEY_ROTATION === "true";
const pinned = process.env.ANTNEST_E2E_SKILL_PINNED === "true";
const cleanupLostResponse =
  process.env.ANTNEST_E2E_SKILL_CLEANUP_LOST_RESPONSE === "true";
const verifyCleanup =
  process.env.ANTNEST_E2E_SKILL_CLEANUP === "true" || cleanupLostResponse;
assert(!verifyCleanup || (!pinned && !keyRotation));
assert(!browserAcceptance || !verifyCleanup);
assert(
  !deployment ||
    ![
      debugLearning,
      uiOutage,
      noticeFailure,
      keyRotation,
      pinned,
      browserAcceptance,
      verifyCleanup,
    ].some(Boolean),
);
assert(
  [
    debugLearning,
    uiOutage,
    noticeFailure,
    keyRotation,
    pinned,
    browserAcceptance,
  ].filter(Boolean).length <= 1,
);
const overlay = [
  "-f",
  "tests/e2e/workspace-closeout/c4.compose.yaml",
  ...learningImageOverlay,
  "-f",
  deployment
    ? "tests/e2e/skill-learning/deployment.compose.yaml"
    : "tests/e2e/skill-learning/compose.yaml",
  ...(noticeFailure
    ? ["-f", "tests/e2e/skill-learning/notice-send-failure.compose.yaml"]
    : []),
  ...(cleanupLostResponse
    ? ["-f", "tests/e2e/skill-learning/held-commit.compose.yaml"]
    : []),
  ...(discovery && !deployment
    ? ["-f", "tests/e2e/skill-learning/discovery.compose.yaml"]
    : []),
  ...(propagation
    ? ["-f", "tests/e2e/skill-learning/propagation.compose.yaml"]
    : []),
];
const logs = (name) => {
  const result = spawnSync("docker", ["logs", "--tail", "200", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
};

test(
  encryptionKeyRotation
    ? "stored-secret key add/activate/rekey/retire preserves existing Runtime, Provider authentication and the full Agent workflow"
    : toolUsability
      ? "ordinary write/edit/read/bash calls feed Skill learning, notice recovery and subsequent use"
      : uiOutage
        ? "Skill learning continues while Agent UI is offline and View restores both changes"
        : noticeFailure
          ? "failed SDK notice closes its connection while View restores the change and the next notice remains live"
          : keyCompromise
            ? "a compromised signer is stopped, stale verifier backup is quarantined, and safe Enable preserves Skill use"
            : keyRotation
              ? "a pretrusted second signer updates a Skill, then RC rebuild removes the old verifier and preserves Skill use"
              : browserAcceptance
                ? "real browser creates and updates a learned Skill, navigates to its source and restores notices without duplicate toasts"
                : pinned
                  ? "an owner pin prevents a learned Skill update without affecting the foreground Run"
                  : propagation
                    ? deployment
                      ? callerDiscovery
                        ? "an active Agent with its own learned projection loads formal and other Agent Skills through standard discovery"
                        : sourceLifecycle
                          ? "normal source Disable/Enable/Delete preserve dynamic read boundaries and independent formal presets"
                          : "standard deployment configuration serves automatic sources, temporary use, real Console promotion and frozen Template rebuild"
                      : "automatic Agent sources, temporary use, real Console promotion and frozen Template rebuild form the full Skill propagation workflow"
                    : "completed Runs create and update a personal Skill, publish notices, and serve the next Run",
  {
    timeout: 1_200_000,
  },
  async () => {
    process.chdir(root);
    const abort = new AbortController();
    const interrupt = () =>
      abort.abort(new Error("Skill learning E2E interrupted"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let config;
    let image;
    let uiImage;
    let learningBrowser;
    let discoveryImage;
    let temporaryRuntimeImage;
    let controllerImage;
    let consoleImage;
    let rcImage;
    let propagationFlow;
    let propagationEvidence;
    let callerEvidence;
    let resourceBaseline;
    let developmentSettings;
    let encryptionEvidence;
    const additionalImages = [];
    const propagationOutput = () =>
      `${root}/artifacts/verification/${callerDiscovery ? "skill-discovery-caller-di3-20261001" : sourceLifecycle ? "skill-source-lifecycle-di2-20261001" : deployment ? "skill-deployment-20261001" : "skill-propagation-di1-20261001"}/${config.project}`;
    const resources = async (docker) => {
      const value = {};
      for (const [kind, args] of [
        ["containers", ["ps", "-aq"]],
        ["running", ["ps", "-q"]],
        ["networks", ["network", "ls", "-q"]],
        ["volumes", ["volume", "ls", "-q"]],
      ])
        value[kind] = (await docker(args)).split(/\s+/u).filter(Boolean).sort();
      return value;
    };
    try {
      config = await configuration(abort.signal);
      if (authenticationIntegration)
        config.env.ANTNEST_E2E_ALLOW_PRIVATE_PROVIDER_ENDPOINTS = "false";
      for (const [service, variable] of [
        ["identity-service", "ANTNEST_E2E_IDENTITY_IMAGE"],
        ["edge-gateway", "ANTNEST_E2E_GATEWAY_IMAGE"],
        ["runtime-egress", "ANTNEST_E2E_EGRESS_IMAGE"],
        ["temporal", "ANTNEST_E2E_TEMPORAL_IMAGE"],
      ]) {
        const candidate = `antnest/${service}:authentication-${config.project.slice(-8)}`;
        config.env[variable] = candidate;
        additionalImages.push({ service, image: candidate });
      }
      const keys = generateKeyPairSync("ed25519");
      const nextKeys = keyRotation ? generateKeyPairSync("ed25519") : null;
      const rawPublic = keys.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      assert.equal(rawPublic.length, 32);
      const nextRawPublic = nextKeys?.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      if (nextRawPublic) assert.equal(nextRawPublic.length, 32);
      image = `antnest/agent-acp-service:skill-learning-${config.project.slice(-8)}`;
      uiImage = `antnest/agent-ui:skill-learning-${config.project.slice(-8)}`;
      controllerImage = `antnest/agent-controller:skill-learning-${config.project.slice(-8)}`;
      if (propagation) {
        consoleImage = `antnest/admin-console:propagation-${config.project.slice(-8)}`;
        rcImage = `antnest/runtime-controller:propagation-${config.project.slice(-8)}`;
        Object.assign(config.env, {
          ANTNEST_E2E_PROPAGATION_CONSOLE_IMAGE: consoleImage,
          ANTNEST_E2E_PROPAGATION_RC_IMAGE: rcImage,
        });
        await mkdir(propagationOutput(), { recursive: true, mode: 0o700 });
      }
      if (discovery) {
        discoveryImage = `antnest/skill-registry:acp-source-${config.project.slice(-8)}`;
        Object.assign(config.env, {
          ANTNEST_E2E_DISCOVERY_REGISTRY_IMAGE: discoveryImage,
        });
      }
      Object.assign(config.env, {
        ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: "false",
        ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "",
        ANTNEST_E2E_HOLD_RELEASE: String(cleanupLostResponse),
        ANTNEST_E2E_SKILL_LEARNING_DEBUG: String(debugLearning),
        ANTNEST_E2E_TOOL_USABILITY: String(toolUsability),
        ANTNEST_C4_AGENT_ACP_IMAGE: image,
        ANTNEST_C4_AGENT_UI_IMAGE: uiImage,
        ...(pinned || propagation
          ? { ANTNEST_E2E_AGENT_CONTROLLER_IMAGE: controllerImage }
          : {}),
        ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
          config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
        ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
          config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(
            ".0/24",
            ".128/25",
          ),
        ANTNEST_E2E_SKILL_SIGNING_KEY: keys.privateKey
          .export({
            format: "der",
            type: "pkcs8",
          })
          .toString("base64"),
        ANTNEST_E2E_SKILL_SIGNING_KID: signingKid,
        ANTNEST_E2E_PINNED: String(pinned),
        ANTNEST_E2E_SKILL_MAINTENANCE_VERIFIERS: JSON.stringify({
          keys: [
            {
              kid: signingKid,
              algorithm: "Ed25519",
              public_key_base64url: rawPublic.toString("base64url"),
            },
            ...(nextRawPublic
              ? [
                  {
                    kid: "fixture-next",
                    algorithm: "Ed25519",
                    public_key_base64url: nextRawPublic.toString("base64url"),
                  },
                ]
              : []),
          ],
        }),
      });
      if (deployment)
        Object.assign(config.env, {
          ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID:
            config.env.ANTNEST_E2E_SKILL_SIGNING_KID,
          ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY:
            config.env.ANTNEST_E2E_SKILL_SIGNING_KEY,
          ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS:
            config.env.ANTNEST_E2E_SKILL_MAINTENANCE_VERIFIERS,
        });
      const docker = dockerClient(config.env, abort.signal, 1_200_000);
      if (propagation) resourceBaseline = await resources(docker);
      for (const { service, image: candidate } of additionalImages) {
        assert.equal(await docker(["image", "ls", "-q", candidate]), "");
        await docker(
          [
            "build",
            "-f",
            service === "temporal"
              ? "scripts/temporal/Dockerfile"
              : `services/${service}/Dockerfile`,
            "-t",
            candidate,
            "--label",
            `io.antnest.authentication-integration=${config.project}`,
            ".",
          ],
          true,
        );
      }
      if (callerDiscovery)
        await writeFile(
          `${propagationOutput()}/baseline.json`,
          JSON.stringify(resourceBaseline),
          { mode: 0o600, flag: "wx" },
        );
      if (temporaryTools) {
        console.log(
          `Temporary acceptance ${config.project}: building isolated Runtime candidate`,
        );
        temporaryRuntimeImage = `antnest/antnest-runtime:acp-temporary-${config.project.slice(-8)}`;
        await docker(
          [
            "build",
            "-f",
            "runtimes/antnest-runtime/Dockerfile",
            "-t",
            temporaryRuntimeImage,
            ".",
          ],
          true,
        );
        config.resolvedImage = await docker([
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          temporaryRuntimeImage,
        ]);
        config.image = temporaryRuntimeImage;
        config.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF = config.image;
        console.log(
          `Temporary acceptance ${config.project}: Runtime candidate built`,
        );
      }
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
      await docker(
        ["build", "-f", "services/agent-ui/Dockerfile", "-t", uiImage, "."],
        true,
      );
      if (discoveryImage)
        await docker(
          [
            "build",
            "-f",
            "services/skill-registry/Dockerfile",
            "-t",
            discoveryImage,
            ".",
          ],
          true,
        );
      if (pinned || propagation)
        await docker(
          [
            "build",
            "-f",
            "services/agent-controller/Dockerfile",
            "-t",
            controllerImage,
            ".",
          ],
          true,
        );
      if (propagation)
        for (const [service, tag] of [
          ["admin-console", consoleImage],
          ["runtime-controller", rcImage],
        ])
          await docker(
            ["build", "-f", `services/${service}/Dockerfile`, "-t", tag, "."],
            true,
          );
      if (deployment) {
        const invalidKid = await assertMaintenanceKidStartupRejected({
          docker,
          image: rcImage,
          project: config.project,
        });
        await writeFile(
          `${propagationOutput()}/maintenance-kid.json`,
          JSON.stringify(
            { signing_kid: signingKid, invalid_configuration: invalidKid },
            null,
            2,
          ),
          { mode: 0o600, flag: "wx" },
        );
      }
      if (!debugLearning && !discovery)
        developmentSettings = await assertStandardComposeIgnoresDebugSettings(
          config,
          abort.signal,
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
      if (propagation) {
        const release = await assertReleasedSkillSurface({
          docker,
          project: config.project,
          rcImage,
          networkPrefix: config.env.ANTNEST_SERVICE_NETWORK_PREFIX,
          credentials: config.credentials,
          user: `${config.env.ANTNEST_SERVICE_AUTH_UID}:${config.env.ANTNEST_SERVICE_AUTH_GID}`,
        });
        await writeFile(
          `${propagationOutput()}/release-surface.json`,
          JSON.stringify(release, null, 2),
          { mode: 0o600 },
        );
      }
      if (authenticationIntegration) {
        await runNetworkMatrix({
          config,
          docker,
          root,
          image,
          output: propagationOutput(),
        });
        const admin = new GatewayClient(config.gateway);
        await admin.request("/api/session/login", {
          body: {
            organization_slug: "stage3",
            email: "stage3-admin@example.com",
            password: "stage3-admin-password",
          },
        });
        for (const path of [
          "/api/admin/provider-models/discovery",
          "/api/admin/provider-connections",
        ]) {
          const response = await admin.request(path, {
            status: 422,
            body: {
              provider_key: "deepseek",
              base_url: "http://identity-service:8080/v1",
              credential: {
                method: "api_key",
                api_key: "synthetic-destination-probe",
              },
              ...(path.endsWith("connections")
                ? {
                    display_name: "Forbidden internal destination",
                    models: [
                      {
                        display_name: "Fixture",
                        model: {
                          model: "stage3-model",
                          context_window: 8192,
                          max_output_tokens: 1024,
                          supports_images: true,
                        },
                      },
                    ],
                  }
                : {}),
            },
          });
          assert.equal(response.body.code, "provider_endpoint_forbidden");
        }
        config.env.ANTNEST_E2E_ALLOW_PRIVATE_PROVIDER_ENDPOINTS = "true";
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--wait",
            "--wait-timeout",
            "120",
            "agent-controller",
            "agent-acp-service",
          ]),
          true,
        );
      }
      const fixture = await setup(config, abort.signal);
      if (authenticationIntegration) {
        const admin = new GatewayClient(config.gateway);
        await admin.request("/api/session/login", {
          body: {
            organization_slug: "stage3",
            email: "stage3-admin@example.com",
            password: "stage3-admin-password",
          },
        });
        const connections = (
          await admin.request("/api/admin/provider-connections")
        ).body.items;
        assert.equal(connections.length, 1);
        const saved = await admin.request(
          `/api/admin/provider-connections/${connections[0].connection_id}/models/discovery`,
        );
        const draft = await admin.request(
          "/api/admin/provider-models/discovery",
          {
            body: {
              provider_key: "deepseek",
              base_url: "http://stage3-model:8080/v1",
              credential: {
                method: "api_key",
                api_key: "stage3-model-secret",
              },
            },
          },
        );
        assert.deepEqual(saved.body, draft.body);
        assert.equal(saved.body.models.length, 1);
        assert.equal(saved.body.models[0].model_id, "stage3-model");
        assert(!JSON.stringify(saved.body).includes("stage3-model-secret"));
        const modelStatus = await fetch(`${config.model}/status`, {
          signal: AbortSignal.timeout(5000),
        }).then((response) => response.json());
        assert.equal(modelStatus.discoveries, 2);
        assert.deepEqual(modelStatus.errors, []);
        await writeFile(
          `${propagationOutput()}/provider-destination.json`,
          JSON.stringify({
            production_private_destinations: "rejected",
            saved_model_discovery: "passed",
            draft_model_discovery: "passed",
            actual_model_discovery_requests: modelStatus.discoveries,
            external_provider_requests: 0,
          }),
          { flag: "wx", mode: 0o600 },
        );
        await runAuthenticatedPeer({
          config,
          docker,
          root,
          image,
          agentId: fixture.agentID,
          mode: "admission",
          output: propagationOutput(),
        });
      }
      if (encryptionKeyRotation) {
        encryptionEvidence = await rotatePlatformKeys({
          config,
          docker,
          fixture,
          compose: (args) => composeArgs(config.project, [...overlay, ...args]),
        });
        await writeFile(
          `${propagationOutput()}/encryption-key-rotation.json`,
          JSON.stringify(encryptionEvidence, null, 2),
          { flag: "wx", mode: 0o600 },
        );
      }
      const postgresContainer = await docker(
        composeArgs(config.project, [...overlay, "ps", "-q", "postgres"]),
      );
      assert(postgresContainer);
      const sql = (query) =>
        docker([
          "exec",
          "-e",
          "PGPASSWORD=antnest-agent-acp-dev",
          postgresContainer,
          "psql",
          "-U",
          "antnest_agent_acp",
          "-d",
          "antnest_agent_acp",
          "-Atc",
          query,
        ]);
      if (debugLearning) {
        config.env.ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS = "true";
        config.env.ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID = fixture.agentID;
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--wait",
            "agent-acp-service",
          ]),
          true,
        );
      }
      const acpContainer = await docker(
        composeArgs(config.project, [
          ...overlay,
          "ps",
          "-q",
          "agent-acp-service",
        ]),
      );
      await assertLearningDebugWarning({
        docker,
        container: acpContainer,
        agentId: debugLearning ? fixture.agentID : undefined,
      });
      if (browserAcceptance) {
        const { openLearningBrowser } = await import("./browser-learning.mjs");
        learningBrowser = await openLearningBrowser({
          config,
          fixture,
          signal: abort.signal,
          output: fileURLToPath(
            new URL(
              `../../../artifacts/verification/skill-learning/${config.project}.browser/`,
              import.meta.url,
            ),
          ),
        });
      }
      const runClient = async (mode, created) => {
        if (learningBrowser)
          return mode === "create"
            ? learningBrowser.create()
            : learningBrowser.update(created);
        const clientName = `${config.project}-skill-learning-${mode}`;
        let output;
        try {
          output = await docker(
            [
              "run",
              "--name",
              clientName,
              "--label",
              `com.docker.compose.project=${config.project}`,
              "--network",
              `${config.project}_gateway-ingress`,
              "-e",
              `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
              "-e",
              `ANTNEST_E2E_LEARNING_MODE=${mode}`,
              "-e",
              `ANTNEST_E2E_MODEL_URL=${config.model.replace("127.0.0.1", "host.docker.internal")}`,
              "-e",
              `ANTNEST_E2E_SKILL_LEARNING_DEBUG=${debugLearning}`,
              ...(noticeFailure
                ? ["-e", "ANTNEST_E2E_NOTICE_SEND_FAILURE=true"]
                : []),
              ...(keyRotation
                ? ["-e", "ANTNEST_E2E_SKILL_KEY_ROTATION=true"]
                : []),
              ...(uiOutage && mode === "update"
                ? ["-e", "ANTNEST_E2E_UI_OFFLINE=true"]
                : []),
              ...(created
                ? [
                    "-e",
                    `ANTNEST_E2E_SESSION_ID=${created.session_id}`,
                    "-e",
                    `ANTNEST_E2E_CREATED_CHANGE_ID=${created.created_change_id}`,
                  ]
                : []),
              "-v",
              `${root}/tests:/app/tests:ro`,
              image,
              "node",
              "/app/tests/e2e/skill-learning/automatic-client.mjs",
            ],
            true,
          );
        } catch (error) {
          const evidence = fileURLToPath(
            new URL(
              "../../../artifacts/verification/skill-learning/",
              import.meta.url,
            ),
          );
          await mkdir(evidence, { recursive: true, mode: 0o700 });
          const clientLog = logs(clientName);
          const modelContainer = await docker(
            composeArgs(config.project, [
              ...overlay,
              "ps",
              "-q",
              "stage3-model",
            ]),
          ).catch(() => "");
          const acpContainer = await docker(
            composeArgs(config.project, [
              ...overlay,
              "ps",
              "-q",
              "agent-acp-service",
            ]),
          ).catch(() => "");
          const postgresContainer = await docker(
            composeArgs(config.project, [...overlay, "ps", "-q", "postgres"]),
          ).catch(() => "");
          const modelStatus = modelContainer
            ? await docker([
                "exec",
                modelContainer,
                "node",
                "-e",
                "fetch('http://127.0.0.1:8080/status').then(r=>r.text()).then(console.log)",
              ]).catch(() => "model status unavailable")
            : "model container unavailable";
          const tasks = postgresContainer
            ? await docker([
                "exec",
                "-e",
                "PGPASSWORD=antnest-agent-acp-dev",
                postgresContainer,
                "psql",
                "-U",
                "antnest_agent_acp",
                "-d",
                "antnest_agent_acp",
                "-Atc",
                "SELECT source_run_id,state,COALESCE(pause_reason,''),model_calls FROM learning_tasks ORDER BY created_at",
              ]).catch(() => "task query unavailable")
            : "postgres container unavailable";
          const decisions = postgresContainer
            ? await docker([
                "exec",
                "-e",
                "PGPASSWORD=antnest-agent-acp-dev",
                postgresContainer,
                "psql",
                "-U",
                "antnest_agent_acp",
                "-d",
                "antnest_agent_acp",
                "-Atc",
                "SELECT run_id,disposition,COALESCE(reason,'') FROM learning_source_decisions ORDER BY decided_at",
              ]).catch(() => "decision query unavailable")
            : "postgres container unavailable";
          await writeFile(
            `${evidence}${config.project}.failure.json`,
            JSON.stringify({
              clientLog,
              modelStatus,
              tasks,
              decisions,
              ...(discovery && postgresContainer
                ? {
                    unresolved: await docker([
                      "exec",
                      "-e",
                      "PGPASSWORD=antnest-agent-acp-dev",
                      postgresContainer,
                      "psql",
                      "-U",
                      "antnest_agent_acp",
                      "-d",
                      "antnest_agent_acp",
                      "-Atc",
                      "SELECT task_id,request_id,action,state,receipt FROM learning_maintenance_intents WHERE state <> 'settled' ORDER BY created_at",
                    ]).catch(() => "unresolved query unavailable"),
                    runtimeLog: logs(`antnest-runtime-${fixture.agentID}`),
                  }
                : {}),
              acpLog: acpContainer
                ? logs(acpContainer)
                : "ACP container unavailable",
            }),
            { flag: "wx", mode: 0o600 },
          );
          throw new Error(
            `Skill learning client failed; model status: ${modelStatus}; tasks: ${tasks}; decisions: ${decisions}; client: ${clientLog.slice(-1000)}`,
            { cause: error },
          );
        }
        return JSON.parse(output.trim().split("\n").at(-1));
      };
      const created = await runClient("create");
      assert.equal(created.status, "skill_created");
      const discoverySteps = [];
      let discoveryOrganizationId;
      const runDiscovery = async (phase, previous) => {
        assert(discovery);
        if (discoveryOrganizationId === undefined) {
          const member = new GatewayClient(config.gateway);
          const login = (
            await member.request("/api/session/login", { body: fixtureMember })
          ).body;
          assert.equal(login.principal.user_id, fixture.ownerID);
          discoveryOrganizationId = login.principal.organization_id;
        }
        // Internal source requests still recheck current access on every read;
        // deriving this immutable tenant identity does not require a new login.
        const organizationId = discoveryOrganizationId;
        const clientName = `${config.project}-source-${phase}`;
        let output;
        try {
          output = await docker(
            [
              "create",
              "--name",
              clientName,
              "--label",
              `com.docker.compose.project=${config.project}`,
              "--network",
              `${config.project}_registry-clients`,
              "--user",
              `${config.env.ANTNEST_SERVICE_AUTH_UID}:${config.env.ANTNEST_SERVICE_AUTH_GID}`,
              "--read-only",
              "--cap-drop",
              "ALL",
              "-e",
              `ANTNEST_E2E_ORG_ID=${organizationId}`,
              "-e",
              `ANTNEST_E2E_ACTOR_ID=${fixture.ownerID}`,
              "-e",
              `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
              "-e",
              `ANTNEST_E2E_DISCOVERY_PHASE=${phase}`,
              "-e",
              `ANTNEST_E2E_SKILL_PROPAGATION=${propagation}`,
              "-e",
              `ANTNEST_E2E_REGISTRY_URL=http://${config.env.ANTNEST_SERVICE_NETWORK_PREFIX}.82:8080`,
              "-e",
              `ANTNEST_E2E_SOURCE_URL=http://${config.env.ANTNEST_SERVICE_NETWORK_PREFIX}.5:8080`,
              "-v",
              `${config.credentials}/agent-acp-service/tokens/skill-registry:/run/auth/registry-token:ro`,
              "-v",
              `${config.credentials}/skill-registry/tokens/agent-acp-service:/run/auth/source-token:ro`,
              ...(previous
                ? [
                    "-e",
                    `ANTNEST_E2E_DISCOVERY_PREVIOUS=${JSON.stringify(previous)}`,
                  ]
                : []),
              "-v",
              `${root}/tests:/app/tests:ro`,
              image,
              "node",
              "/app/tests/e2e/skill-learning/discovery-client.mjs",
            ],
            true,
          );
          await docker([
            "network",
            "connect",
            `${config.project}_edge`,
            clientName,
          ]);
          output = await docker(["start", "-a", clientName], true);
        } catch (error) {
          const evidence = `${root}/artifacts/verification/skill-discovery-d2-20261001`;
          await mkdir(evidence, { recursive: true, mode: 0o700 });
          await writeFile(
            `${evidence}/${config.project}-source-${phase}.log`,
            logs(clientName),
            { flag: "wx", mode: 0o600 },
          );
          throw error;
        }
        await docker(["rm", clientName]);
        const result = JSON.parse(output.trim().split("\n").at(-1));
        discoverySteps.push(result);
        return result;
      };
      if (discovery) {
        await runDiscovery("create");
        if (propagation) {
          const { openPropagationFlow } =
            await import("./propagation-flow.mjs");
          propagationFlow = await openPropagationFlow({
            config,
            fixture,
            docker,
            sql,
            signal: abort.signal,
            output: propagationOutput(),
          });
          await propagationFlow.create(discoverySteps[0]);
        }
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "stop",
            "--timeout",
            "10",
            "skill-registry",
          ]),
          true,
        );
      }
      if (cleanupLostResponse) {
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
              `fetch('http://127.0.0.1:18093/${path}',{method:'${method}'}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))`,
            ]),
          );
        await until(
          async () => (await gate("status")).pending,
          "real release response held",
          abort.signal,
          30_000,
        );
        assert.deepEqual(await gate("drop", "POST"), { dropped: true });
      }
      let runtimeContainerBeforeRotation;
      if (keyRotation) {
        const runtimeName = `antnest-runtime-${fixture.agentID}`;
        runtimeContainerBeforeRotation = await docker([
          "inspect",
          "--format",
          "{{.Id}}",
          runtimeName,
        ]);
        assert(runtimeContainerBeforeRotation);
        assert(nextKeys);
        config.env.ANTNEST_E2E_SKILL_SIGNING_KID = "fixture-next";
        config.env.ANTNEST_E2E_SKILL_SIGNING_KEY = nextKeys.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64");
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            "--no-build",
            "--no-deps",
            "--force-recreate",
            "agent-acp-service",
          ]),
          true,
        );
        assert.equal(
          await docker(["inspect", "--format", "{{.Id}}", runtimeName]),
          runtimeContainerBeforeRotation,
        );
      }
      if (noticeFailure) {
        const acpContainer = await docker(
          composeArgs(config.project, [
            ...overlay,
            "ps",
            "-q",
            "agent-acp-service",
          ]),
        );
        assert(acpContainer);
        const injected = JSON.parse(
          await docker([
            "exec",
            "-e",
            "NODE_OPTIONS=",
            acpContainer,
            "node",
            "-e",
            "fetch('http://127.0.0.1:18094/status').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))",
          ]),
        );
        assert.deepEqual(injected, { failures: 1 });
      }
      assert.match(fixture.agentID, /^agent_[a-z0-9]+$/u);
      if (cleanupLostResponse) {
        await until(
          async () =>
            Number(
              await sql(
                `SELECT count(*) FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='release' AND intent.state='settled' AND intent.receipt->>'outcome'='released'`,
              ),
            ) === 1,
          "lost cleanup response recovered before next foreground Run",
          abort.signal,
          30_000,
        );
      }
      if (!debugLearning) {
        const advanced = await docker([
          "exec",
          "-e",
          "PGPASSWORD=antnest-agent-acp-dev",
          postgresContainer,
          "psql",
          "-U",
          "antnest_agent_acp",
          "-d",
          "antnest_agent_acp",
          "-c",
          `UPDATE learning_review_attempts SET started_at=clock_timestamp()-interval '11 minutes' WHERE task_id IN (SELECT id FROM learning_tasks WHERE agent_id='${fixture.agentID}' AND state='completed')`,
        ]);
        assert(
          advanced.includes("UPDATE 1"),
          "fixture cooldown advance did not affect one review",
        );
      }
      if (uiOutage)
        await docker(
          composeArgs(config.project, [...overlay, "stop", "agent-ui"]),
          true,
        );
      let result;
      if (pinned) {
        const clientName = `${config.project}-skill-learning-pinned-update`;
        let output;
        try {
          output = await docker(
            [
              "run",
              "--name",
              clientName,
              "--label",
              `com.docker.compose.project=${config.project}`,
              "--network",
              `${config.project}_gateway-ingress`,
              "-e",
              `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
              "-e",
              `ANTNEST_E2E_SESSION_ID=${created.session_id}`,
              "-v",
              `${root}/tests:/app/tests:ro`,
              image,
              "node",
              "/app/tests/e2e/skill-learning/pinned-update-client.mjs",
            ],
            true,
          );
        } catch (error) {
          throw new Error(
            `Pinned update client failed: ${logs(clientName).slice(-2000)}`,
            { cause: error },
          );
        }
        result = JSON.parse(output.trim().split("\n").at(-1));
        assert.equal(result.status, "pinned_update_run_completed");
        let lastTasks = "unread";
        try {
          await until(
            async () => {
              lastTasks = (
                await sql(
                  `SELECT state,COALESCE(pause_reason,''),model_calls FROM learning_tasks WHERE agent_id='${fixture.agentID}' ORDER BY created_at`,
                )
              ).trim();
              return lastTasks === "completed||1\nskipped||1"
                ? lastTasks
                : null;
            },
            "pinned Skill proposal is skipped",
            abort.signal,
            90_000,
          );
        } catch (error) {
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
          const acpContainer = await docker(
            composeArgs(config.project, [
              ...overlay,
              "ps",
              "-q",
              "agent-acp-service",
            ]),
          ).catch(() => "");
          throw new Error(
            `Pinned learning did not settle: tasks=${lastTasks}; model=${modelStatus}; acp=${acpContainer ? logs(acpContainer).slice(-2000) : "unavailable"}`,
            { cause: error },
          );
        }
        assert.equal(
          (
            await sql(
              `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
            )
          ).trim(),
          "1",
        );
        const member = new GatewayClient(config.gateway);
        await member.request("/api/session/login", { body: fixtureMember });
        const view = (
          await member.request(
            `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${created.session_id}`,
          )
        ).body;
        assert.deepEqual(
          (view.systemNotices ?? []).map((item) => item.changeId),
          [created.created_change_id],
        );
      } else {
        result = await runClient("update", created);
      }
      if (keyRotation)
        assert.equal(
          await docker([
            "inspect",
            "--format",
            "{{.Id}}",
            `antnest-runtime-${fixture.agentID}`,
          ]),
          runtimeContainerBeforeRotation,
        );
      if (!pinned)
        assert.equal(
          result.status,
          uiOutage
            ? "automatic_learning_during_ui_outage"
            : "automatic_learning_passed",
        );
      let registryAcceptance;
      let discoveryToolEvidence;
      let temporaryToolEvidence;
      if (propagationFlow) await propagationFlow.duringRegistryOutage();
      if (discovery) {
        // The second real learning settlement succeeds while Registry is down.
        assert.equal(
          Number(
            await sql(
              `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
            ),
          ),
          2,
        );
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "restart",
            "--timeout",
            "10",
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
            "90",
            "--no-build",
            "--no-deps",
            "skill-registry",
          ]),
          true,
        );
        const updated = await runDiscovery("update", discoverySteps[0]);
        if (discoveryTools) {
          const target = await fixture.json("/api/admin/agents", {
            status: 202,
            body: {
              owner_user_id: fixture.ownerID,
              name: "Skill discovery target",
              template_id: fixture.template.template_id,
              template_revision: fixture.template.revision,
            },
          });
          const targetId = target.agent.agent_id;
          await fixture.operation(target.operation.request_id);
          await waitForAgentReady(
            () => fixture.json(`/api/admin/agents/${targetId}`),
            abort.signal,
          );
          if (temporaryTools)
            await runAuthenticatedPeer({
              config,
              docker,
              root,
              image,
              agentId: targetId,
              mode: "policy-off",
              output: propagationOutput(),
            });
          const clientName = `${config.project}-discovery-tools`;
          let output;
          try {
            output = await docker(
              [
                "run",
                "--name",
                clientName,
                "--label",
                `com.docker.compose.project=${config.project}`,
                "--network",
                `${config.project}_gateway-ingress`,
                "-e",
                `ANTNEST_E2E_AGENT_ID=${targetId}`,
                "-e",
                `ANTNEST_E2E_SOURCE_AGENT_ID=${fixture.agentID}`,
                "-e",
                `ANTNEST_E2E_SKILL_TEMPORARY=${temporaryTools}`,
                "-v",
                `${root}/tests:/app/tests:ro`,
                image,
                "node",
                "/app/tests/e2e/skill-learning/discovery-tools-client.mjs",
              ],
              true,
            );
          } catch (error) {
            const outputDir = `${root}/artifacts/verification/skill-discovery-d3-20261001`;
            await mkdir(outputDir, { recursive: true, mode: 0o700 });
            await writeFile(
              `${outputDir}/${config.project}-tools-client.log`,
              logs(clientName),
              { flag: "wx", mode: 0o600 },
            );
            await writeFile(
              `${outputDir}/${config.project}-tools-failure.json`,
              JSON.stringify({
                source_agent_id: fixture.agentID,
                target_agent_id: targetId,
                runs: await sql(
                  `SELECT json_agg(json_build_object('run_id',r.id,'state',r.state,'error_class',r.error_class,'tools',(SELECT json_agg(json_build_object('name',a.tool_name,'source',a.source,'state',a.state,'effect',a.tool_effect_state)) FROM tool_attempts a WHERE a.run_id=r.id))) FROM runs r JOIN acp_sessions s ON s.id=r.session_id WHERE s.agent_id='${targetId}'`,
                ),
              }),
              { flag: "wx", mode: 0o600 },
            );
            throw error;
          }
          await docker(["rm", clientName]);
          discoveryToolEvidence = JSON.parse(output.trim().split("\n").at(-1));
          const attempts = JSON.parse(
            await sql(
              `SELECT json_agg(json_build_object('source',a.source,'name',a.tool_name,'state',a.state,'effect',a.tool_effect_state) ORDER BY a.started_at,a.id) FROM tool_attempts a JOIN runs r ON r.id=a.run_id WHERE r.session_id='${discoveryToolEvidence.session_id}'`,
            ),
          );
          assert.deepEqual(
            attempts.map((attempt) => attempt.name),
            ["find_skill", "load_skill"],
          );
          assert(
            attempts.every(
              (attempt) =>
                attempt.source === "agent" &&
                attempt.state === "completed" &&
                attempt.effect === "none",
            ),
          );
          discoveryToolEvidence.attempts = attempts;
          discoveryToolEvidence.trace = await collectDiscoveryTrace(
            config,
            {
              agent_id: fixture.agentID,
              sequence: updated.item.skill_ref.sequence,
              content_digest: updated.item.content_digest,
            },
            abort.signal,
          );
          if (temporaryTools)
            temporaryToolEvidence = await temporaryAcpFlow({
              config,
              docker,
              overlay,
              root,
              image,
              targetId,
              sourceId: fixture.agentID,
              sql,
              signal: abort.signal,
            });
          if (propagationFlow)
            updated.formal = await propagationFlow.update(updated, targetId);
          if (callerDiscovery) {
            callerEvidence = await callerAcpFlow({
              config,
              fixture,
              docker,
              sql,
              signal: abort.signal,
              root,
              image,
              formal: updated.formal,
              output: propagationOutput(),
            });
            await propagationFlow.recordCaller(callerEvidence);
          }
        }
        const columns = await sql(
          "SELECT column_name FROM information_schema.columns WHERE table_name='skill_source_projections' ORDER BY ordinal_position",
        );
        assert(!/artifact|skill_text|instructions/u.test(columns));
        if (sourceLifecycle) {
          for (const kind of ["disable", "enable", "delete"])
            await propagationFlow.sourceLifecycle(kind, (phase) =>
              runDiscovery(phase, updated),
            );
        } else {
          // An extra real file changes the *full* directory manifest, even though
          // SKILL.md still matches the old candidate. Stale candidates cannot substitute.
          await docker([
            "exec",
            "--user",
            "1000",
            `antnest-runtime-${fixture.agentID}`,
            "sh",
            "-c",
            "printf changed > /workspace/.antnest/skills/fixture-procedure/extra.txt",
          ]);
          await runDiscovery("changed", updated);
          await until(
            async () =>
              Number(
                await sql(
                  `SELECT sent_sequence FROM skill_source_projections WHERE agent_id='${fixture.agentID}' AND NOT active`,
                ),
              ) === 3,
            "durable removal projection delivered",
            abort.signal,
            60000,
          );
        }
        if (propagationFlow)
          propagationEvidence = await propagationFlow.afterRemoval();
      }
      let cleanupEvidence;
      if (verifyCleanup) {
        await until(
          async () =>
            Number(
              await sql(
                `SELECT count(*) FROM learning_maintenance_intents intent JOIN learning_tasks task ON task.id=intent.task_id WHERE task.agent_id='${fixture.agentID}' AND intent.action='release' AND intent.state='settled' AND intent.receipt->>'outcome'='released'`,
              ),
            ) === 2,
          "both settled learning candidates must be released",
          abort.signal,
          30_000,
        );
        assert.equal(
          Number(
            await sql(
              `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
            ),
          ),
          2,
          "cleanup must preserve applied change records",
        );
        const physical = JSON.parse(
          await docker([
            "exec",
            "--user",
            "1000:1000",
            `antnest-runtime-${fixture.agentID}`,
            "node",
            "-e",
            "const fs=require('node:fs');const count=p=>fs.existsSync(p)?fs.readdirSync(p,{withFileTypes:true}).filter(x=>x.isDirectory()).length:0;console.log(JSON.stringify({candidates:count('/workspace/.antnest/skill-learning/candidates'),detached:count('/workspace/.antnest/skill-learning/release-stage'),active:fs.existsSync('/workspace/.antnest/skills/fixture-procedure/SKILL.md')}))",
          ]),
        );
        assert.deepEqual(physical, {
          candidates: 0,
          detached: 0,
          active: true,
        });
        cleanupEvidence = {
          released: 2,
          lostResponseInjected: cleanupLostResponse,
          physical,
        };
      }
      if (!uiOutage && !pinned && !discovery) {
        const candidate = JSON.parse(
          await docker([
            "exec",
            "-e",
            "PGPASSWORD=antnest-agent-acp-dev",
            postgresContainer,
            "psql",
            "-U",
            "antnest_agent_acp",
            "-d",
            "antnest_agent_acp",
            "-Atc",
            `SELECT row_to_json(candidate) FROM (SELECT task.organization_id,encode(item.artifact,'hex') AS artifact_hex,item.target_digest,item.artifact_digest FROM learning_candidates item JOIN learning_tasks task ON task.id=item.task_id WHERE task.agent_id='${fixture.agentID}' AND item.state='applied' ORDER BY item.created_at DESC LIMIT 1) candidate`,
          ]),
        );
        assert(candidate.organization_id && candidate.artifact_hex);
        const registryOutput = await docker(
          [
            "run",
            "--name",
            `${config.project}-skill-learning-registry-check`,
            "--label",
            `com.docker.compose.project=${config.project}`,
            "--network",
            `${config.project}_gateway-ingress`,
            "-e",
            `ANTNEST_E2E_CANDIDATE_ARTIFACT_HEX=${candidate.artifact_hex}`,
            "-e",
            `ANTNEST_E2E_ORGANIZATION_ID=${candidate.organization_id}`,
            "-e",
            `ANTNEST_E2E_ACTOR_ID=${fixture.ownerID}`,
            "-e",
            `ANTNEST_E2E_CONTENT_DIGEST=${candidate.target_digest}`,
            "-e",
            `ANTNEST_E2E_ARTIFACT_DIGEST=${candidate.artifact_digest}`,
            "-e",
            `ANTNEST_E2E_REGISTRY_TOKEN=${config.env.ANTNEST_SKILL_REGISTRY_API_TOKEN ?? "antnest-skill-registry-local-development-token"}`,
            "-v",
            `${root}/tests:/app/tests:ro`,
            image,
            "node",
            "/app/tests/e2e/skill-learning/registry-acceptance-client.mjs",
          ],
          true,
        );
        registryAcceptance = JSON.parse(
          registryOutput.trim().split("\n").at(-1),
        );
        assert.equal(registryAcceptance.status, "candidate_registry_accepted");
      }
      if (uiOutage) {
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            "--no-build",
            "agent-ui",
          ]),
          true,
        );
        const member = new GatewayClient(config.gateway);
        await member.request("/api/session/login", { body: fixtureMember });
        const notices = await until(
          async () => {
            try {
              const view = (
                await member.request(
                  `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${created.session_id}`,
                )
              ).body;
              const items = view.systemNotices ?? [];
              return items.some(
                (item) => item.changeId === created.created_change_id,
              ) &&
                items.some((item) => item.changeId === result.updated_change_id)
                ? items
                : null;
            } catch {
              return null;
            }
          },
          "Agent View restoration after UI outage",
          abort.signal,
          60_000,
        );
        assert.equal(notices.length, 2);
        assert.equal(new Set(notices.map((notice) => notice.changeId)).size, 2);
      }
      const compromiseEvidence = keyCompromise
        ? await isolateCompromisedRuntime({
            config,
            overlay,
            docker,
            fixture,
            image,
            keys,
            nextKeys,
          })
        : null;
      let removedKey;
      let postRebuild;
      if (keyRotation) {
        assert(nextRawPublic && nextKeys);
        config.env.ANTNEST_E2E_SKILL_MAINTENANCE_VERIFIERS = JSON.stringify({
          keys: [
            {
              kid: "fixture-next",
              algorithm: "Ed25519",
              public_key_base64url: nextRawPublic.toString("base64url"),
            },
          ],
        });
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            "--no-build",
            "--no-deps",
            "--force-recreate",
            "runtime-controller",
          ]),
          true,
        );
        const accepted = await fixture.json(
          `/api/admin/agents/${fixture.agentID}/${keyCompromise ? "enable" : "rebuild"}`,
          {
            status: 202,
            headers: { "Idempotency-Key": randomUUID() },
            body: keyCompromise
              ? {}
              : {
                  template_id: fixture.template.template_id,
                  template_revision: fixture.template.revision,
                },
          },
        );
        await fixture.operation((accepted.operation ?? accepted).request_id);
        await fixture.ready();
        if (keyCompromise) {
          await docker(
            composeArgs(config.project, [
              ...overlay,
              "up",
              "-d",
              "--wait",
              "--wait-timeout",
              "120",
              "--no-build",
              "--no-deps",
              "--force-recreate",
              "agent-acp-service",
            ]),
            true,
          );
          const readinessMember = new GatewayClient(config.gateway);
          await readinessMember.request("/api/session/login", {
            body: fixtureMember,
          });
          await until(
            async () => {
              try {
                const view = await readinessMember.request(
                  `/api/app/workspace/v1/agents/${fixture.agentID}/view`,
                );
                return view.body.availability === "ready";
              } catch {
                return false;
              }
            },
            "fresh ACP execution directory after incident signer restart",
            abort.signal,
            60_000,
          );
        }
        const runtimeName = `antnest-runtime-${fixture.agentID}`;
        const runtimeInspect = JSON.parse(
          await docker(["inspect", runtimeName]),
        )[0];
        assert.notEqual(runtimeInspect.Id, runtimeContainerBeforeRotation);
        const runtimeSpec = JSON.parse(
          runtimeInspect.Config.Env.find((value) =>
            value.startsWith("ANTNEST_RUNTIME_SPEC="),
          ).slice("ANTNEST_RUNTIME_SPEC=".length),
        );
        assert.deepEqual(
          runtimeSpec.skill_maintenance_verifiers.keys.map((key) => key.kid),
          ["fixture-next"],
        );
        const managementNetwork = config.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK;
        const runtimeIp =
          runtimeInspect.NetworkSettings.Networks[managementNetwork]?.IPAddress;
        assert(
          runtimeIp,
          "replacement Runtime must join the management network",
        );
        const clientName = `${config.project}-skill-learning-key-removal`;
        let output;
        try {
          output = await docker(
            [
              "run",
              "--name",
              clientName,
              "--label",
              `com.docker.compose.project=${config.project}`,
              "--network",
              managementNetwork,
              "-e",
              `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
              "-e",
              `ANTNEST_E2E_RUNTIME_IP=${runtimeIp}`,
              "-e",
              `ANTNEST_E2E_OLD_SIGNING_KEY=${keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`,
              "-e",
              `ANTNEST_E2E_NEXT_SIGNING_KEY=${config.env.ANTNEST_E2E_SKILL_SIGNING_KEY}`,
              "-v",
              `${root}/tests:/app/tests:ro`,
              image,
              "node",
              "/app/tests/e2e/skill-learning/key-removal-client.mjs",
            ],
            true,
          );
        } catch (error) {
          throw new Error(
            `Key removal client failed: ${logs(clientName).slice(-2000)}`,
            { cause: error },
          );
        }
        removedKey = JSON.parse(output.trim().split("\n").at(-1));
        assert.equal(removedKey.status, "removed_key_rejected");
        const verifyClientName = `${config.project}-skill-learning-post-rebuild`;
        let verifyOutput;
        try {
          verifyOutput = await docker(
            [
              "run",
              "--name",
              verifyClientName,
              "--label",
              `com.docker.compose.project=${config.project}`,
              "--network",
              `${config.project}_gateway-ingress`,
              "-e",
              `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
              "-e",
              `ANTNEST_E2E_SESSION_ID=${created.session_id}`,
              "-v",
              `${root}/tests:/app/tests:ro`,
              image,
              "node",
              "/app/tests/e2e/skill-learning/post-rebuild-client.mjs",
            ],
            true,
          );
        } catch (error) {
          throw new Error(
            `Post-rebuild Skill use failed: ${logs(verifyClientName).slice(-2000)}`,
            { cause: error },
          );
        }
        postRebuild = JSON.parse(verifyOutput.trim().split("\n").at(-1));
        assert.equal(postRebuild.status, "learned_skill_read_after_rebuild");
      }
      const evidence = fileURLToPath(
        new URL(
          "../../../artifacts/verification/skill-learning/",
          import.meta.url,
        ),
      );
      let debugRead;
      if (debugLearning) {
        assert.equal(
          await sql(
            `SELECT count(*) FROM learning_tasks WHERE agent_id='${fixture.agentID}' AND state='completed' AND review_prompt_version=2`,
          ),
          "2",
        );
        await assertLearningDebugWarning({
          docker,
          container: acpContainer,
          agentId: fixture.agentID,
        });
        config.env.ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID = "";
        config.env.ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS = "false";
        await docker(
          composeArgs(config.project, [
            ...overlay,
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--wait",
            "agent-acp-service",
          ]),
          true,
        );
        debugRead = await runClient("verify", created);
        assert.equal(debugRead.status, "debug_learned_skill_read");
      }
      const learningTrace = verifyLearningTrace
        ? await collectLearningTraces(
            config,
            fixture.agentID,
            [created.created_change_id, result.updated_change_id],
            abort.signal,
          )
        : undefined;
      if (debugLearning) {
        assert(
          learningTrace.summaries.every(
            (summary) =>
              summary.debug === true &&
              summary.modelCalls === 2 &&
              summary.rejectionReasons.includes("debug_skip"),
          ),
        );
      }
      let toolEvidence;
      if (toolUsability) {
        toolEvidence = JSON.parse(
          await sql(`SELECT json_agg(json_build_object(
            'run_id',r.id,'state',r.state,'stop_reason',r.stop_reason,
            'tools',(SELECT json_agg(json_build_object('name',a.tool_name,'state',a.state)
              ORDER BY a.started_at,a.id) FROM tool_attempts a WHERE a.run_id=r.id)
          ) ORDER BY r.created_at,r.id) FROM runs r
          JOIN learning_tasks t ON t.source_run_id=r.id
          WHERE t.agent_id='${fixture.agentID}' AND t.state='completed'`),
        );
        assert.equal(toolEvidence.length, 2);
        for (const run of toolEvidence) {
          assert.equal(run.state, "completed");
          assert.equal(run.stop_reason, "end_turn");
          assert.deepEqual(
            run.tools.map((tool) => tool.name),
            ["write", "edit", "read", "bash"],
          );
          assert(run.tools.every((tool) => tool.state === "completed"));
        }
      }
      await mkdir(evidence, { recursive: true, mode: 0o700 });
      await writeFile(
        `${evidence}${config.project}.json`,
        JSON.stringify({
          ...result,
          ...(encryptionEvidence
            ? { encryptionKeyRotation: encryptionEvidence }
            : {}),
          ...(developmentSettings ? { developmentSettings } : {}),
          ...(toolEvidence ? { toolEvidence } : {}),
          ...(learningTrace ? { learningTrace } : {}),
          ...(debugRead ? { debugRead } : {}),
          ...(registryAcceptance ? { registryAcceptance } : {}),
          ...(discovery ? { discovery: discoverySteps } : {}),
          ...(discoveryToolEvidence
            ? { discoveryTools: discoveryToolEvidence }
            : {}),
          ...(temporaryToolEvidence
            ? { temporaryTools: temporaryToolEvidence }
            : {}),
          ...(propagationEvidence ? { propagation: propagationEvidence } : {}),
          ...(callerEvidence ? { caller: callerEvidence } : {}),
          ...(cleanupEvidence ? { cleanup: cleanupEvidence } : {}),
          ...(removedKey ? { removedKey } : {}),
          ...(compromiseEvidence ? { keyCompromise: compromiseEvidence } : {}),
          ...(postRebuild ? { postRebuild } : {}),
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (propagation && config) {
        await propagationFlow?.captureFailure(error);
        const diagnostics = {
          error: { name: error.name, message: error.message },
          services: {},
        };
        const readDocker = dockerClient(config.env, undefined, 60000);
        for (const service of [
          "agent-acp-service",
          "agent-controller",
          "runtime-controller",
          "skill-registry",
          "agent-ui",
          "stage3-model",
        ]) {
          const id = await readDocker(
            composeArgs(config.project, [
              ...overlay,
              "ps",
              "-a",
              "-q",
              service,
            ]),
          ).catch(() => "");
          if (id) diagnostics.services[service] = logs(id);
          if (id && service === "stage3-model")
            diagnostics.model_status = await readDocker([
              "exec",
              id,
              "node",
              "-e",
              "fetch('http://127.0.0.1:8080/status').then(r=>r.text()).then(console.log)",
            ]).catch(() => "unavailable");
        }
        await writeFile(
          `${propagationOutput()}/service-failure.json`,
          JSON.stringify(diagnostics),
          { flag: "wx", mode: 0o600 },
        );
      }
      throw error;
    } finally {
      try {
        try {
          await learningBrowser?.close();
        } finally {
          await propagationFlow?.close();
        }
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        if (config) {
          await cleanup(config);
          {
            const cleanImages = dockerClient(config.env, undefined, 120000);
            const existingImages = new Set(
              (
                await cleanImages([
                  "image",
                  "ls",
                  "--format",
                  "{{.Repository}}:{{.Tag}}",
                ])
              ).split(/\s+/u),
            );
            for (const ownedImage of [
              image,
              uiImage,
              discoveryImage,
              temporaryRuntimeImage,
              ...(pinned || propagation ? [controllerImage] : []),
              ...(propagation ? [consoleImage, rcImage] : []),
              ...additionalImages.map(({ image }) => image),
            ].filter((tag) => tag && existingImages.has(tag)))
              await cleanImages(["image", "rm", ownedImage]);
            if (propagation && resourceBaseline) {
              const after = await resources(cleanImages);
              await writeFile(
                `${propagationOutput()}/cleanup.json`,
                JSON.stringify({ before: resourceBaseline, after }),
                { flag: "wx", mode: 0o600 },
              );
              assert.deepEqual(
                after,
                resourceBaseline,
                "DI1 must leave all pre-existing Docker resources unchanged",
              );
            }
          }
        }
      }
    }
  },
);
