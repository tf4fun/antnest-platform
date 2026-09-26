import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { member, setup, until } from "../workspace-closeout/c4-setup.mjs";
import { verifyControlsBrowser } from "./workspace-controls-browser.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fromAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = fromAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/agent-ui/workspace-api.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({ strict: true, validateFormats: false }).compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/controlCommandResult",
});

// Backend-only acceptance: real Gateway authentication/CSRF, Node Bridge,
// ACP/Postgres and Runtime, with a deterministic model endpoint. Set
// ANTNEST_UI_CONTROL_BROWSER=1 to verify the rendered consumer against this stack.
test(
  "workspace commands preserve real authorization, configuration CAS and running work",
  { timeout: 900_000 },
  async (context) => {
    process.chdir(root);
    const abort = new AbortController();
    const interrupt = () =>
      abort.abort(new Error("Workspace controls E2E interrupted"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    context.signal.addEventListener("abort", interrupt, { once: true });
    let config;
    const images = [];
    const evidence = {
      capturedAt: new Date().toISOString(),
      checks: [],
      commands: [],
    };
    const check = (description) => {
      evidence.checks.push(description);
      process.stdout.write(`[backend controls] ${description}\n`);
    };
    try {
      config = await configuration(abort.signal);
      evidence.project = config.project;
      const suffix = config.project.slice(-8);
      const uiImage = `antnest/agent-ui:controls-e2e-${suffix}`;
      const acpImage = `antnest/agent-acp-service:controls-e2e-${suffix}`;
      const gatewayImage = `antnest/edge-gateway:controls-e2e-${suffix}`;
      images.push(uiImage, acpImage, gatewayImage);
      Object.assign(config.env, {
        ANTNEST_C4_AGENT_UI_IMAGE: uiImage,
        ANTNEST_UI_E2E_ACP_IMAGE: acpImage,
        ANTNEST_UI_E2E_GATEWAY_IMAGE: gatewayImage,
        ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
        ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
          config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
        ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
          config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(
            ".0/24",
            ".128/25",
          ),
      });
      const docker = dockerClient(config.env, abort.signal, 800_000);
      const stack = (args) =>
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          ...args,
        ]);
      for (const [file, image] of [
        ["services/agent-ui/Dockerfile", uiImage],
        ["services/agent-acp-service/Dockerfile", acpImage],
        ["services/edge-gateway/Dockerfile", gatewayImage],
      ])
        await docker(["build", "-f", file, "-t", image, "."], true);
      await docker(
        stack(["up", "-d", "--wait", "--wait-timeout", "180", "--no-build"]),
        true,
      );
      process.stdout.write("[backend controls] isolated stack ready\n");
      const fixture = await setup(config, abort.signal);
      const client = new GatewayClient(config.gateway);
      await client.request("/api/session/login", { body: member });
      const base = `/api/app/workspace/v1/agents/${fixture.agentID}`;
      const command = async (
        text,
        sessionId = null,
        extra = {},
        status = 200,
      ) => {
        const { body } = await client.request(`${base}/commands`, {
          body: { text, sessionId, ...extra },
          status,
        });
        if (status === 200) {
          assert.ok(validate(body), JSON.stringify(validate.errors));
          evidence.commands.push(body.command);
        }
        return body;
      };
      const view = async (sessionId) =>
        (
          await client.request(
            `${base}/view${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
          )
        ).body;
      const sessions = async () =>
        (await client.request(`${base}/sessions`)).body;
      const model = async () => {
        const response = await fetch(`${config.model}/status`, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.errors, []);
        return body;
      };

      assert.deepEqual((await sessions()).items, []);
      assert.match((await command("/帮助")).text, /\/new/);
      assert.match((await command("/status")).text, /New conversation/);
      assert.match((await command("/sessions")).text, /No conversations/);
      assert.equal((await command("/resume")).selection, undefined);
      assert.deepEqual((await command("/new")).selection, { sessionId: null });
      assert.deepEqual((await sessions()).items, []);
      assert.equal((await model()).requests.length, 0);
      check("draft controls create no Session or model request");

      // A second advertised model exposes thought_level without ever executing it.
      await fixture.json("/api/admin/provider-connections", {
        status: 201,
        body: {
          provider_key: "deepseek",
          display_name: "Controls reasoning fixture",
          base_url: "http://stage3-model:8080/v1",
          credential: { method: "api_key", api_key: "stage3-model-secret" },
          models: [
            {
              display_name: "Controls reasoning",
              model: {
                model: "deepseek-v4-flash",
                context_window: 8192,
                max_output_tokens: 1024,
                supports_images: false,
              },
            },
          ],
        },
      });
      const profiles = (await fixture.json("/api/admin/model-profiles")).items;
      const reasoning = profiles.find(
        (profile) => profile.display_name === "Controls reasoning",
      );
      assert.ok(reasoning?.model_profile_id);
      const sessionId = (
        await client.request(`${base}/sessions`, { status: 201, body: {} })
      ).body.sessionId;
      let selected = (await view(sessionId)).selectedView;
      assert.match(
        (await command("/model", sessionId)).text,
        /Controls reasoning/,
      );
      assert.match((await command("/mode", sessionId)).text, /\/mode chat/);
      await command(`/model profile:${reasoning.model_profile_id}`, sessionId, {
        expectedConfigurationToken: selected.configurationToken,
      });
      selected = (await view(sessionId)).selectedView;
      assert.equal(
        selected.configOptions.find((option) => option.id === "model")
          .currentValue,
        `profile:${reasoning.model_profile_id}`,
      );
      assert.match(
        (await command("/thinking", sessionId)).text,
        /\/thinking high/,
      );
      await command("/thinking high", sessionId, {
        expectedConfigurationToken: selected.configurationToken,
      });
      selected = (await view(sessionId)).selectedView;
      assert.equal(
        selected.configOptions.find((option) => option.id === "thinking_effort")
          .currentValue,
        "high",
      );
      await command("/model agent_default", sessionId, {
        expectedConfigurationToken: selected.configurationToken,
      });
      selected = (await view(sessionId)).selectedView;
      assert.equal(
        selected.configOptions.find((option) => option.id === "model")
          .currentValue,
        "agent_default",
      );
      assert.equal(
        (await command("/thinking high", sessionId, {}, 422)).code,
        "command_unavailable",
      );
      assert.equal((await model()).requests.length, 0);
      check(
        "model and thinking follow capabilities and persist without model calls",
      );

      const sessionPath = `${base}/sessions/${sessionId}`;
      const submit = async (text) => {
        const before = (await view(sessionId)).selectedView;
        const intentId = randomUUID();
        await client.request(`${sessionPath}/prompts`, {
          status: 202,
          headers: {
            "Idempotency-Key": intentId,
            "If-Match": before.historyToken,
          },
          body: {
            intentId,
            expectedAppendVersion: before.appendVersion,
            prompt: [{ type: "text", text }],
          },
        });
        return until(
          async () => {
            const operation = (
              await client.request(`${sessionPath}/operations/${intentId}`)
            ).body;
            assert.notEqual(
              operation.phase,
              "failed",
              `Prompt admission failed: ${operation.errorClass}`,
            );
            return operation.phase === "running" && operation.runId
              ? operation
              : null;
          },
          "accepted operation",
          abort.signal,
        );
      };
      const waitPhase = (operation, phase) =>
        until(
          async () => {
            const observed = (
              await client.request(
                `${sessionPath}/operations/${operation.operationId}`,
              )
            ).body;
            return observed.phase === phase && observed;
          },
          `operation ${phase}`,
          abort.signal,
        );
      const held = await submit("c4-browser-hold-cancel");
      await until(
        async () => (await model()).pending.includes("c4-browser-hold-cancel"),
        "held model request",
        abort.signal,
      );
      const busyBefore = await view(sessionId);
      for (const text of [
        "/help",
        "/status",
        "/usage",
        "/sessions",
        "/resume",
        "/model",
        "/mode",
      ])
        await command(text, sessionId);
      assert.match((await command("/status", sessionId)).text, /busy/);
      assert.deepEqual((await command(`/resume ${sessionId}`)).selection, {
        sessionId,
      });
      assert.deepEqual((await command("/new", sessionId)).selection, {
        sessionId: null,
      });
      assert.equal(
        (await command("/fork", sessionId, {}, 409)).code,
        "session_busy",
      );
      const busyAfter = await view(sessionId);
      assert.equal(
        busyAfter.selectedView.appendVersion,
        busyBefore.selectedView.appendVersion,
      );
      assert.equal(
        busyAfter.selectedView.turns.length,
        busyBefore.selectedView.turns.length,
      );
      assert.equal((await sessions()).items.length, 1);
      assert.equal((await model()).requests.length, 1);
      assert.ok((await model()).pending.includes("c4-browser-hold-cancel"));
      check(
        "read and navigation controls preserve the held Run and transcript",
      );

      // Concurrent callers submit the same observed token; ACP must admit one writer.
      selected = (await view(sessionId)).selectedView;
      const racingWrite = async (value) => {
        const response = await fetch(`${config.gateway}${base}/commands`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Cookie: client.cookie,
            Origin: config.gateway,
            "X-Antnest-CSRF-Token": client.cookies.get("antnest_csrf"),
          },
          body: JSON.stringify({
            text: `/mode ${value}`,
            sessionId,
            expectedConfigurationToken: selected.configurationToken,
          }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        return { status: response.status, body: await response.json(), value };
      };
      const racers = await Promise.all([
        racingWrite("auto"),
        racingWrite("chat"),
      ]);
      assert.deepEqual(racers.map((item) => item.status).sort(), [200, 409]);
      assert.equal(
        racers.find((item) => item.status === 409).body.code,
        "configuration_conflict",
      );
      const winner = racers.find((item) => item.status === 200);
      assert.ok(validate(winner.body), JSON.stringify(validate.errors));
      selected = (await view(sessionId)).selectedView;
      assert.equal(
        selected.configOptions.find((option) => option.id === "mode")
          .currentValue,
        winner.value,
      );
      assert.equal((await model()).requests.length, 1);
      check(
        "concurrent busy mode writes produce exactly one success and one CAS conflict",
      );

      await command(
        "/stop",
        sessionId,
        { operationId: held.operationId, expectedRunId: "run-stale" },
        409,
      );
      assert.ok((await model()).pending.includes("c4-browser-hold-cancel"));
      await command("/stop", sessionId, {
        operationId: held.operationId,
        expectedRunId: held.runId,
      });
      await waitPhase(held, "cancelled");
      const successor = await submit("c4-browser-hold-after-cancel");
      await until(
        async () =>
          (await model()).pending.includes("c4-browser-hold-after-cancel"),
        "successor model request",
        abort.signal,
      );
      await command(
        "/stop",
        sessionId,
        { operationId: held.operationId, expectedRunId: held.runId },
        409,
      );
      assert.ok(
        (await model()).pending.includes("c4-browser-hold-after-cancel"),
      );
      const released = await fetch(
        `${config.model}/release/c4-browser-hold-after-cancel`,
        {
          method: "POST",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        },
      );
      assert.equal(released.status, 200);
      await waitPhase(successor, "completed");
      assert.equal((await model()).requests.length, 2);
      check(
        "targeted stop cancels only its observed Run and old targets cannot stop a successor",
      );

      assert.match(
        (await command("/usage", sessionId)).text,
        /Context: \d+ \/ \d+ tokens/,
      );
      const fork = await command("/fork", sessionId);
      assert.ok(
        fork.selection.sessionId && fork.selection.sessionId !== sessionId,
      );
      const forkView = await view(fork.selection.sessionId);
      assert.equal(forkView.selectedView.historyState, "ready");
      assert.ok(
        JSON.stringify(forkView.selectedView.turns).includes(
          "c4-browser-hold-after-cancel completed",
        ),
      );
      assert.equal((await sessions()).items.length, 2);
      assert.equal((await model()).requests.length, 2);
      check(
        "idle fork copies completed history once and reported usage is available",
      );

      const anonymous = new GatewayClient(config.gateway);
      await anonymous.request(`${base}/commands`, {
        status: 401,
        body: { text: "/help", sessionId: null },
      });
      await client.request(`${base}/commands`, {
        status: 403,
        headers: { "X-Antnest-CSRF-Token": "wrong" },
        body: { text: "/new", sessionId },
      });
      const stranger = {
        organization_slug: "stage3",
        email: "controls-stranger@example.com",
        password: "controls-stranger-password",
      };
      await fixture.json("/api/admin/directory/users", {
        body: {
          email: stranger.email,
          display_name: "Controls stranger",
          password: stranger.password,
          role: "member",
        },
      });
      const strangerClient = new GatewayClient(config.gateway);
      await strangerClient.request("/api/session/login", { body: stranger });
      await strangerClient.request(`${base}/commands`, {
        status: 403,
        body: { text: "/resume " + sessionId, sessionId: null },
      });
      await command("/resume session_missing", null, {}, 404);
      if (process.env.ANTNEST_UI_CONTROL_BROWSER === "1") {
        evidence.browser = await verifyControlsBrowser({
          config,
          fixture,
          signal: abort.signal,
          sessionId,
          reasoning,
          view,
          sessions,
          model,
          output: `${root}artifacts/verification/agent-ui-controls-browser/${suffix}`,
        });
        check(
          "browser commands synchronize model controls, SSE observer, Session URL and sidebar without Provider calls",
        );
      }
      await fixture.json(
        `/api/admin/directory/users/${fixture.ownerID}/active`,
        { body: { active: false } },
      );
      await client.request(`${base}/commands`, {
        status: 401,
        body: { text: "/status", sessionId },
      });
      assert.equal((await model()).requests.length, 2);
      check(
        "Gateway login, CSRF, principal scope, missing Session and revocation guard commands",
      );
      assert.deepEqual([...new Set(evidence.commands)].sort(), [
        "fork",
        "help",
        "mode",
        "model",
        "new",
        "resume",
        "sessions",
        "status",
        "stop",
        "thinking",
        "usage",
      ]);
      evidence.status = "passed";
    } catch (cause) {
      evidence.status = "failed";
      evidence.failure =
        cause instanceof Error ? cause.message : "Unknown failure";
      throw cause;
    } finally {
      abort.abort();
      try {
        if (config) {
          await cleanup(config);
          const docker = dockerClient(config.env, undefined, 60_000);
          for (const image of images)
            await docker(["image", "rm", image]).catch(() => {});
          evidence.cleanup = "passed";
        }
      } finally {
        const directory = new URL(
          "../../../artifacts/verification/workspace-commands-20260926/",
          import.meta.url,
        );
        await mkdir(directory, { recursive: true });
        const name = `backend-docker-${evidence.capturedAt.replaceAll(/[:.]/g, "-")}.json`;
        await writeFile(
          new URL(name, directory),
          JSON.stringify(evidence, null, 2) + "\n",
        );
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        context.signal.removeEventListener("abort", interrupt);
      }
    }
  },
);
