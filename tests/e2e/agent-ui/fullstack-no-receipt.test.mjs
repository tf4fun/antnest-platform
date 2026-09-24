import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { member, setup, until } from "../workspace-closeout/c4-setup.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fromAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Client } = fromAcp("pg");
const execFileAsync = promisify(execFile);
const overlays = [
  "-f",
  "tests/e2e/workspace-closeout/c4.compose.yaml",
  "-f",
  "tests/e2e/agent-ui/fullstack.compose.yaml",
  "-f",
  "tests/e2e/agent-ui/no-receipt.compose.yaml",
  "--profile",
  "ui-no-receipt",
];

test(
  "real ACP reconciles pre-forward and arrived-uncommitted Prompts across Bridge crashes",
  { timeout: 600_000 },
  async () => {
    process.chdir(root);
    const abort = new AbortController();
    const interrupt = () =>
      abort.abort(new Error("No-receipt E2E interrupted"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let config;
    let phase = "configuration";
    const images = [];
    try {
      config = await configuration(abort.signal);
      phase = "build images";
      const suffix = config.project.slice(-8);
      const uiImage = `antnest/agent-ui:ui-no-receipt-${suffix}`;
      const acpImage = `antnest/agent-acp-service:ui-no-receipt-${suffix}`;
      const gatewayImage = `antnest/edge-gateway:ui-no-receipt-${suffix}`;
      images.push(uiImage, acpImage, gatewayImage);
      Object.assign(config.env, {
        ANTNEST_C4_AGENT_UI_IMAGE: uiImage,
        ANTNEST_UI_E2E_ACP_IMAGE: acpImage,
        ANTNEST_UI_E2E_GATEWAY_IMAGE: gatewayImage,
        ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
          config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
        ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
          config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(
            ".0/24",
            ".128/25",
          ),
      });
      const docker = dockerClient(config.env, abort.signal, 600_000);
      for (const [file, image] of [
        ["services/agent-acp-service/Dockerfile", acpImage],
        ["services/agent-ui/Dockerfile", uiImage],
        ["services/edge-gateway/Dockerfile", gatewayImage],
      ])
        await docker(["build", "-f", file, "-t", image, "."], true);
      phase = "start stack";
      await docker(
        composeArgs(config.project, [
          ...overlays,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "180",
          "--no-build",
        ]),
        true,
      );
      phase = "create fixture";
      const fixture = await setup(config, abort.signal);
      const memberClient = new GatewayClient(config.gateway);
      await memberClient.request("/api/session/login", { body: member });
      const principal = (await memberClient.request("/api/session")).body
        .principal;
      const headers = {
        "x-antnest-organization-id": principal.organization_id,
        "x-antnest-principal-id": principal.user_id,
        "x-antnest-agent-id": fixture.agentID,
      };
      const mappedPort = async (service) => {
        const address = (
          await docker(
            composeArgs(config.project, [...overlays, "port", service, "8080"]),
          )
        ).trim();
        assert.match(address, /^127\.0\.0\.1:\d+$/u);
        return `http://${address}`;
      };
      const gate = await mappedPort("acp-gate");
      let ui = await mappedPort("agent-ui-fault");
      const uiContainer = await docker(
        composeArgs(config.project, [
          ...overlays,
          "ps",
          "-q",
          "agent-ui-fault",
        ]),
      );
      assert.ok(uiContainer);
      const sessionId = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          { status: 201, body: {} },
        )
      ).body.sessionId;
      const path = `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${sessionId}`;
      const view = async () => {
        const response = await fetch(`${ui}${path}/view`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      phase = "first fault Bridge view";
      const firstView = await view();
      assert.ok(firstView.historyToken);
      const originalAppendVersion = firstView.appendVersion;
      assert.ok(Number.isSafeInteger(originalAppendVersion));
      const intentId = `no-receipt-${suffix}`;
      const prompt = "c4-browser-window-00";
      const gateControl = async (action, body) => {
        const response = await fetch(`${gate}/__fault/${action}`, {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      phase = "arm ACP gate";
      await gateControl("arm", { intentId });
      const admission = () => ({
        intentId,
        expectedAppendVersion: originalAppendVersion,
        prompt: [{ type: "text", text: prompt }],
      });
      const postPrompt = async (historyToken) => {
        const response = await fetch(`${ui}${path}/prompts`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "idempotency-key": intentId,
            "if-match": historyToken,
          },
          body: JSON.stringify(admission()),
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(response.status, 202);
        return response.json();
      };
      phase = "submit held Prompt";
      assert.equal(
        (await postPrompt(firstView.historyToken)).acceptance,
        "bridge",
      );
      phase = "observe held Prompt";
      await until(
        async () => (await gateControl("state")).heldIntent === intentId,
        "ACP gate holds the exact Prompt before producer admission",
        abort.signal,
        10_000,
      );
      assert.equal((await gateControl("state")).forwardedPrompts, 0);
      phase = "kill fault Bridge";
      await docker(["kill", "--signal=SIGKILL", uiContainer], true);
      await gateControl("disarm", {});
      phase = "restart fault Bridge";
      await docker(
        composeArgs(config.project, [
          ...overlays,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "60",
          "--no-deps",
          "--no-build",
          "agent-ui-fault",
        ]),
        true,
      );
      ui = await mappedPort("agent-ui-fault");
      const operation = async () => {
        const response = await fetch(`${ui}${path}/operations/${intentId}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      phase = "query uncertain operation";
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.deepEqual(await operation(), {
          operationId: intentId,
          sessionId,
          acceptance: "unknown",
          phase: "uncertain",
        });
      }
      const cancelled = await fetch(
        `${ui}${path}/operations/${intentId}/cancel`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ expectedRunId: "run-not-confirmed" }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      assert.equal(
        cancelled.status,
        409,
        "An unknown intent has no confirmed Run to cancel",
      );
      assert.equal(
        (await gateControl("state")).forwardedPrompts,
        0,
        "Recovery reads must not submit the Prompt",
      );
      const requests = async () =>
        (
          await (
            await fetch(`${config.model}/status`, {
              signal: AbortSignal.timeout(10_000),
            })
          ).json()
        ).requests.filter((row) => row.phase === prompt);
      assert.equal((await requests()).length, 0);
      phase = "read rebound view";
      const rebound = await view();
      assert.ok(rebound.historyToken);
      phase = "retry original intent";
      assert.equal(
        (await postPrompt(rebound.historyToken)).acceptance,
        "bridge",
      );
      phase = "await completed Run";
      const completed = await until(
        async () => {
          const current = await operation();
          return current.phase === "completed" ? current : null;
        },
        "explicit retry produces one durable Run",
        abort.signal,
      );
      assert.equal(completed.acceptance, "acp");
      assert.ok(completed.runId);
      assert.equal((await gateControl("state")).forwardedPrompts, 1);
      assert.equal((await requests()).length, 1);

      phase = "hold ACP admission transaction";
      const arrivedSessionId = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          { status: 201, body: {} },
        )
      ).body.sessionId;
      const arrivedPath = `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${arrivedSessionId}`;
      const arrivedIntentId = `arrived-no-receipt-${suffix}`;
      const arrivedPrompt = "c4-browser-window-01";
      const connectionString = `postgres://antnest_agent_acp:${encodeURIComponent(config.env.ANTNEST_AGENT_ACP_POSTGRES_PASSWORD ?? "antnest-agent-acp-dev")}@127.0.0.1:${config.env.ANTNEST_POSTGRES_HOST_PORT}/antnest_agent_acp`;
      const database = new Client({ connectionString });
      const observer = new Client({ connectionString });
      await database.connect();
      await observer.connect();
      let locked = false;
      try {
        const arrivedViewResponse = await fetch(`${ui}${arrivedPath}/view`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(arrivedViewResponse.status, 200);
        const arrivedView = await arrivedViewResponse.json();
        assert.ok(arrivedView.historyToken);
        assert.ok(Number.isSafeInteger(arrivedView.appendVersion));
        await database.query("BEGIN");
        await database.query(
          "SELECT id FROM acp_sessions WHERE id = $1 FOR UPDATE",
          [arrivedSessionId],
        );
        locked = true;
        phase = "submit Prompt that reaches ACP before receipt persistence";
        const arrivedPost = async (historyToken) => {
          const response = await fetch(`${ui}${arrivedPath}/prompts`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              "idempotency-key": arrivedIntentId,
              "if-match": historyToken,
            },
            body: JSON.stringify({
              intentId: arrivedIntentId,
              expectedAppendVersion: arrivedView.appendVersion,
              prompt: [{ type: "text", text: arrivedPrompt }],
            }),
            signal: AbortSignal.timeout(15_000),
          });
          assert.equal(response.status, 202);
          return response.json();
        };
        assert.equal(
          (await arrivedPost(arrivedView.historyToken)).acceptance,
          "bridge",
        );
        const blockedAdmission = async () => {
          const result = await observer.query(
            `SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
                AND query LIKE '%FROM acp_sessions WHERE id = $1 FOR UPDATE%'`,
          );
          return result.rows[0].count;
        };
        phase = "verify ACP reached the locked transaction";
        try {
          await until(
            async () => (await blockedAdmission()) > 0,
            "ACP admission waits on the Session row after receiving Prompt",
            abort.signal,
            15_000,
          );
        } catch (error) {
          const activity = await observer.query(
            `SELECT state, wait_event_type, wait_event, left(query, 100) AS query
               FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND usename = 'antnest_agent_acp'`,
          );
          throw new Error(
            `ACP lock waiter absent: ${JSON.stringify(activity.rows)}`,
            { cause: error },
          );
        }
        assert.equal((await gateControl("state")).forwardedPrompts, 2);
        assert.equal(
          (
            await observer.query(
              "SELECT count(*)::int AS count FROM runs WHERE session_id = $1 AND bridge_intent_id = $2",
              [arrivedSessionId, arrivedIntentId],
            )
          ).rows[0].count,
          0,
          "No durable receipt is visible before releasing the lock",
        );
        phase = "crash Bridge while ACP admission is blocked";
        const currentUiContainer = await docker(
          composeArgs(config.project, [
            ...overlays,
            "ps",
            "-q",
            "agent-ui-fault",
          ]),
        );
        await docker(["kill", "--signal=SIGKILL", currentUiContainer], true);
        await docker(
          composeArgs(config.project, [
            ...overlays,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "60",
            "--no-deps",
            "--no-build",
            "agent-ui-fault",
          ]),
          true,
        );
        ui = await mappedPort("agent-ui-fault");
        let lastOperationFailure = null;
        const arrivedOperation = async () => {
          const response = await fetch(
            `${ui}${arrivedPath}/operations/${arrivedIntentId}`,
            {
              headers,
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (response.status === 503) {
            lastOperationFailure = await response
              .json()
              .catch(() => ({ code: "invalid_error_body" }));
            return null;
          }
          assert.equal(response.status, 200);
          return response.json();
        };
        phase = "query arrived but uncommitted intent";
        const whileLocked = await arrivedOperation();
        if (whileLocked !== null)
          assert.deepEqual(whileLocked, {
            operationId: arrivedIntentId,
            sessionId: arrivedSessionId,
            acceptance: "unknown",
            phase: "uncertain",
          });
        assert.equal((await gateControl("state")).forwardedPrompts, 2);
        await database.query("ROLLBACK");
        locked = false;
        await until(
          async () => (await blockedAdmission()) === 0,
          "ACP admission leaves the blocked transaction",
          abort.signal,
          15_000,
        );
        phase = "replace fail-stopped ACP producer";
        const acpContainer = await docker(
          composeArgs(config.project, [
            ...overlays,
            "ps",
            "-a",
            "-q",
            "agent-acp-service",
          ]),
        );
        assert.ok(acpContainer);
        await until(
          async () => {
            const state = JSON.parse(
              await docker([
                "inspect",
                "--format",
                "{{json .State}}",
                acpContainer,
              ]),
            );
            return (
              state.Status === "exited" &&
              state.ExitCode === 1 &&
              !state.OOMKilled
            );
          },
          "ACP fail-stops after uncertain admission persistence",
          abort.signal,
          20_000,
        );
        await docker(
          composeArgs(config.project, [
            ...overlays,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "60",
            "--no-deps",
            "--no-build",
            "agent-acp-service",
          ]),
          true,
        );
        phase = "reconcile arrived intent after lock release";
        let afterRelease;
        try {
          afterRelease = await until(
            arrivedOperation,
            "Bridge can query the intent after ACP admission lock is released",
            abort.signal,
            30_000,
          );
        } catch (error) {
          const direct = await fetch(
            `${gate}/rpc/agent-acp/workspace/sessions/${arrivedSessionId}/execution`,
            {
              headers,
              signal: AbortSignal.timeout(10_000),
            },
          );
          const directBody = await direct.json().catch(() => ({}));
          throw new Error(
            `Reconciliation unavailable: ${JSON.stringify({
              bridge: lastOperationFailure?.code ?? null,
              bridgeMessage: lastOperationFailure?.message ?? null,
              acpStatus: direct.status,
              acpCode: directBody.code ?? null,
            })}`,
            { cause: error },
          );
        }
        assert.equal(
          (await gateControl("state")).forwardedPrompts,
          2,
          "Bridge must not resubmit an arrived intent during recovery reads",
        );
        if (afterRelease.acceptance === "unknown") {
          const nextViewResponse = await fetch(`${ui}${arrivedPath}/view`, {
            headers,
            signal: AbortSignal.timeout(15_000),
          });
          assert.equal(nextViewResponse.status, 200);
          const nextView = await nextViewResponse.json();
          await arrivedPost(nextView.historyToken);
        } else {
          assert.equal(afterRelease.acceptance, "acp");
        }
        const arrivedCompleted = await until(
          async () => {
            const current = await arrivedOperation();
            return current?.phase === "completed" ? current : null;
          },
          "arrived intent resolves to one durable Run",
          abort.signal,
        );
        assert.equal(arrivedCompleted.acceptance, "acp");
        assert.ok(arrivedCompleted.runId);
        assert.equal(
          (
            await observer.query(
              "SELECT count(*)::int AS count FROM runs WHERE session_id = $1 AND bridge_intent_id = $2",
              [arrivedSessionId, arrivedIntentId],
            )
          ).rows[0].count,
          1,
        );
        assert.equal(
          (await gateControl("state")).forwardedPrompts,
          afterRelease.acceptance === "unknown" ? 3 : 2,
        );
        const arrivedRequests = (
          await (
            await fetch(`${config.model}/status`, {
              signal: AbortSignal.timeout(10_000),
            })
          ).json()
        ).requests.filter((row) => row.phase === arrivedPrompt);
        assert.equal(arrivedRequests.length, 1);
      } finally {
        if (locked) await database.query("ROLLBACK").catch(() => {});
        await database.end().catch(() => {});
        await observer.end().catch(() => {});
      }
    } catch (error) {
      let evidence = "";
      if (config) {
        const directory = `${root}/artifacts/verification/agent-ui-no-receipt-diagnostics`;
        await mkdir(directory, { recursive: true });
        const services = {};
        for (const name of [
          "agent-acp-service",
          "acp-gate",
          "agent-ui-fault",
        ]) {
          try {
            const { stdout: id } = await execFileAsync(
              "docker",
              composeArgs(config.project, [
                ...overlays,
                "ps",
                "-a",
                "-q",
                name,
              ]),
              { env: config.env, timeout: 10_000 },
            );
            if (!id.trim()) continue;
            const state = await execFileAsync(
              "docker",
              ["inspect", "--format", "{{json .State}}", id.trim()],
              { env: config.env, timeout: 10_000 },
            );
            const logs = await execFileAsync(
              "docker",
              ["logs", "--tail", "120", id.trim()],
              { env: config.env, timeout: 10_000, maxBuffer: 1024 * 1024 },
            );
            services[name] = {
              state: JSON.parse(state.stdout),
              logs: logs.stdout + logs.stderr,
            };
          } catch (diagnosticError) {
            services[name] = { diagnosticError: diagnosticError.message };
          }
        }
        evidence = `${directory}/${Date.now()}-${config.project}.json`;
        await writeFile(
          evidence,
          JSON.stringify({ phase, services }, null, 2) + "\n",
        );
      }
      throw new Error(
        `No-receipt E2E failed during ${phase}${evidence ? ` (private evidence: ${evidence})` : ""}`,
        { cause: error },
      );
    } finally {
      abort.abort();
      if (config) {
        await cleanup(config);
        const docker = dockerClient(config.env, undefined, 60_000);
        for (const image of images)
          await docker(["image", "rm", image]).catch(() => {});
      }
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  },
);
