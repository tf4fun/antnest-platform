import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import {
  parseIntentObservation,
  parseExecutionObservation,
} from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { audioData } from "../acp-multimodal/fixtures.mjs";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { member, setup, until } from "../workspace-closeout/c4-setup.mjs";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/agent-acp/workspace-bridge.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validator = new Ajv2020({ strict: true, validateFormats: false });
const validReceipt = validator.compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/intentReceipt",
});
const validExecution = validator.compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/executionObservation",
});
const ownerLabel = "io.antnest.verification.project";

test(
  "Gateway failed Run produces schema-valid Bridge receipts and a durable workspace failure",
  {
    timeout: 900_000,
    skip: process.env.ANTNEST_UI_RECEIPT_E2E !== "1",
  },
  async (t) => {
    process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, t.signal]);
    const interrupt = () => abort.abort(new Error("Receipt E2E interrupted"));
    for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
    let before, config, browser, failure;
    const candidates = [];
    const problems = [];
    try {
      before = await snapshotEnvironment({ signal });
      config = await configuration(signal);
      const suffix = config.project.slice(-8);
      const specs = [
        ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
        ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
        ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
        ["identity-service", "ANTNEST_RECEIPT_E2E_IDENTITY_IMAGE"],
        ["runtime-controller", "ANTNEST_RECEIPT_E2E_RC_IMAGE"],
      ];
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
      const docker = dockerClient(config.env, signal, 900_000);
      const compose = (args) =>
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/receipt-contract.compose.yaml",
          ...args,
        ]);
      for (const [service, variable] of specs) {
        const image = `antnest/${service}:receipt-e2e-${suffix}`;
        assert.equal(
          await docker(["image", "ls", "-q", "--filter", `reference=${image}`]),
          "",
          "Candidate tag already exists",
        );
        config.env[variable] = image;
        candidates.push(image);
        console.log(JSON.stringify({ phase: "build", service }));
        const [, ...build] = candidateCommand({
          name: service,
          tag: image,
          build: [
            "docker",
            "build",
            "-f",
            `services/${service}/Dockerfile`,
            "--label",
            `${ownerLabel}=${config.project}`,
            "-t",
            image,
            ".",
          ],
          labels: { [ownerLabel]: config.project },
        });
        await docker(build, true, { env: candidateEnvironment(config.env) });
      }
      console.log(JSON.stringify({ phase: "start" }));
      await docker(
        compose(["up", "-d", "--wait", "--wait-timeout", "180", "--no-build"]),
        true,
      );
      const fixture = await setup(config, signal);
      const client = new GatewayClient(config.gateway);
      const principal = (
        await client.request("/api/session/login", { body: member })
      ).body.principal;
      assert.equal(principal.user_id, fixture.ownerID);
      const sessionId = (
        await client.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          { status: 201, body: {} },
        )
      ).body.sessionId;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.addCookies(
        [...client.cookies].map(([name, value]) => ({
          name,
          value,
          url: config.gateway,
        })),
      );
      const page = await context.newPage();
      page.on("pageerror", () => problems.push("pageerror"));
      page.on("websocket", () => problems.push("browser-websocket"));
      await page.goto(
        `${config.gateway}/workspace/${fixture.agentID}/sessions/${sessionId}`,
        { waitUntil: "domcontentloaded" },
      );
      const composer = page.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(() => composer.isEnabled(), "Composer ready", signal);
      await page.getByLabel("File attachments", { exact: true }).setInputFiles({
        name: "unsupported.wav",
        mimeType: "audio/wav",
        buffer: Buffer.from(audioData, "base64"),
      });
      await composer.fill("c4-browser-unsupported-audio");
      await composer.press("Enter");
      const operation = await until(
        async () => {
          const view = (
            await client.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
            )
          ).body;
          return view.operations?.find(
            (value) =>
              value.sessionId === sessionId &&
              value.phase === "failed" &&
              value.runId,
          );
        },
        "Durable failed operation",
        signal,
      );
      assert.equal(operation.errorClass, "model_unsupported_content");

      // ACP is private. Capture its actual HTTP wire from the owned Agent UI
      // container, authenticated the way Agent UI calls it: its own service
      // credential plus a workspace caller context that Identity issues for
      // the logged-in member's session and this Agent.
      const containerId = await docker(compose(["ps", "-q", "agent-ui"]), true);
      const row = JSON.parse(await docker(["inspect", containerId]))[0];
      assert.equal(
        row.Config.Labels["com.docker.compose.project"],
        config.project,
      );
      assert.equal(row.Config.Labels["com.docker.compose.service"], "agent-ui");
      const accessToken = client.cookies.get("antnest_session");
      assert(accessToken, "Gateway login did not set a session cookie");
      // Secrets reach the exec only through the Docker client environment,
      // never through command-line arguments.
      const wireDocker = dockerClient(
        {
          ...config.env,
          RECEIPT_ACCESS_TOKEN: accessToken,
          RECEIPT_GATEWAY_IDENTITY_TOKEN: readFileSync(
            `${config.credentials}/edge-gateway/tokens/identity-service`,
            "utf8",
          ).trim(),
        },
        signal,
        120_000,
      );
      const readWire = async (path) =>
        JSON.parse(
          await wireDocker([
            "exec",
            "--env",
            "RECEIPT_ACCESS_TOKEN",
            "--env",
            "RECEIPT_GATEWAY_IDENTITY_TOKEN",
            containerId,
            "node",
            "--input-type=module",
            "-e",
            `import { readFileSync } from "node:fs";
       const signal = AbortSignal.timeout(10000);
       const issued = await fetch("http://identity-service:8080/rpc/identity/resolve-access-token", { method: "POST", headers: { "Antnest-Service-Authorization": "Bearer " + process.env.RECEIPT_GATEWAY_IDENTITY_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ access_token: process.env.RECEIPT_ACCESS_TOKEN, profile: "workspace", agent_id: process.argv[2] }), redirect: "error", signal });
       if (!issued.ok) throw new Error("Caller context status " + issued.status);
       const { caller_context } = await issued.json();
       const credential = readFileSync("/etc/antnest/service-auth/tokens/agent-acp-service", "utf8").trim();
       const response = await fetch(process.argv[1], { headers: { "Antnest-Service-Authorization": "Bearer " + credential, "Antnest-Caller-Context": caller_context }, redirect: "error", signal });
       if (!response.ok) throw new Error("Bridge observation status " + response.status);
       process.stdout.write(await response.text());`,
            `http://agent-acp-workspace:8080/rpc/agent-acp/workspace/sessions/${encodeURIComponent(sessionId)}/${path}`,
            fixture.agentID,
          ]),
        );
      const receipt = await readWire(
        `intents/${encodeURIComponent(operation.operationId)}`,
      );
      const execution = await readWire("execution");
      assert.equal(
        validReceipt(receipt),
        true,
        "Actual ACP receipt violates the shared schema",
      );
      assert.equal(
        validExecution(execution),
        true,
        "Actual ACP execution observation violates the shared schema",
      );
      assert.equal(receipt.intentId, operation.operationId);
      assert.equal(receipt.runId, operation.runId);
      assert.equal(receipt.sessionId, sessionId);
      assert.equal(receipt.errorClass, operation.errorClass);
      assert.equal(receipt.phase, "failed");
      assert.deepEqual(
        execution.recentReceipts.find(
          (value) => value.intentId === receipt.intentId,
        ),
        receipt,
      );
      const response = (value) =>
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        });
      assert.deepEqual(await parseIntentObservation(response(receipt)), {
        kind: "receipt",
        receipt,
      });
      assert.deepEqual(
        await parseExecutionObservation(response(execution)),
        execution,
      );

      const alert = page.getByRole("alert").filter({
        hasText: "The selected model does not support this attachment type.",
      });
      await alert.waitFor({ timeout: 120_000 });
      await until(
        () => composer.isEnabled(),
        "Composer reenabled after failure",
        signal,
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await alert.waitFor({ timeout: 120_000 });
      await until(
        () => composer.isEnabled(),
        "Composer reenabled after reload",
        signal,
      );
      const reloaded = (
        await client.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
        )
      ).body;
      assert.equal(
        reloaded.operations.length,
        1,
        "Reload must not resubmit a failed Prompt",
      );
      assert.equal(reloaded.operations[0].operationId, receipt.intentId);
      assert.equal(reloaded.operations[0].errorClass, receipt.errorClass);
      const modelResponse = await fetch(`${config.model}/status`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      assert.equal(modelResponse.ok, true, "Controlled model status failed");
      const model = await modelResponse.json();
      assert.equal(
        model.requests.some(
          (request) => request.phase === "c4-browser-unsupported-audio",
        ),
        false,
        "Unsupported content must fail before inference",
      );
      assert.deepEqual(problems, []);
      const evidence = {
        receipt,
        execution,
        checks: [
          "gateway-failed-run",
          "actual-acp-receipt-schema",
          "actual-acp-observation-schema",
          "node-parsers",
          "workspace-failure-and-reload",
          "no-model-inference",
        ],
      };
      assertSecretFree(JSON.stringify(evidence), [
        member.password,
        "stage3-model-secret",
        ...client.cookies.values(),
      ]);
      writeEvidenceFile(
        process.env.ANTNEST_UI_RECEIPT_E2E_OUTPUT ??
          `artifacts/verification/${config.project}-bridge-receipt`,
        "receipt.json",
        JSON.stringify(evidence, null, 2),
      );
      console.log(
        JSON.stringify({ phase: "verified", checks: evidence.checks }),
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const errors = [];
      const attempt = async (action) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(async () => browser?.close());
      if (config) {
        await attempt(() => cleanup(config));
        const docker = dockerClient(config.env, undefined, 180_000);
        for (const image of candidates)
          await attempt(async () => {
            if (
              !(await docker([
                "image",
                "ls",
                "-q",
                "--filter",
                `reference=${image}`,
              ]))
            )
              return;
            const row = JSON.parse(
              await docker(["image", "inspect", image]),
            )[0];
            assert.equal(
              row.Config.Labels[ownerLabel],
              config.project,
              "Candidate cleanup ownership changed",
            );
            await docker(["image", "rm", image]);
            assert.equal(
              await docker([
                "image",
                "ls",
                "-q",
                "--filter",
                `reference=${image}`,
              ]),
              "",
            );
          });
      }
      if (before)
        await attempt(async () => {
          const comparison = compareEnvironment(
            before,
            await snapshotEnvironment({ before }),
          );
          assert.equal(comparison.unchanged, true, JSON.stringify(comparison));
          console.log(JSON.stringify({ phase: "cleanup", ...comparison }));
        });
      for (const event of ["SIGINT", "SIGTERM"]) process.off(event, interrupt);
      if (errors.length)
        throw new AggregateError(
          [...(failure ? [failure] : []), ...errors],
          "Receipt E2E cleanup failed",
        );
    }
  },
);
