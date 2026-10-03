import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { audioData, imageData } from "../acp-multimodal/fixtures.mjs";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { member, setup, until } from "../workspace-closeout/c4-setup.mjs";

const ownerLabel = "io.antnest.verification.project";

async function assertWorkspacePolicy(page, response) {
  assert.equal(response.status(), 200, "Workspace document failed");
  const headers = await response.headersArray();
  const values = (name) =>
    headers
      .filter((header) => header.name.toLowerCase() === name)
      .map((header) => header.value);
  const policies = values("content-security-policy");
  assert.equal(policies.length, 1, "Gateway must not add a second CSP");
  assert.deepEqual(values("x-content-type-options"), ["nosniff"]);
  const nonce = /'nonce-([a-f0-9]{32})'/u.exec(policies[0])?.[1];
  assert(nonce, "Agent UI nonce policy missing");
  assert.match(policies[0], /img-src 'self' data: blob:/u);
  assert.match(policies[0], /media-src 'self' data: blob:/u);
  // Browsers hide nonce attribute values; the IDL property retains the nonce.
  assert.equal(
    await page
      .locator("#workspace-bootstrap")
      .evaluate((script) => script.nonce),
    nonce,
  );

  // Current SSR bootstraps directory metadata, then loads history in the browser.
  // Exercise the document's real nonce policy explicitly, so client hydration
  // cannot conceal a blocked streaming-script policy.
  const result = await page.evaluate(
    async ({ nonce, audioData }) => {
      const script = document.createElement("script");
      script.nonce = nonce;
      script.textContent =
        'document.documentElement.dataset.securityNonceProbe = "executed"';
      document.body.append(script);
      script.remove();
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      const bytes = Uint8Array.from(atob(audioData), (value) =>
        value.charCodeAt(0),
      );
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Blob audio metadata timed out")),
            10_000,
          );
          audio.onloadedmetadata = () => {
            clearTimeout(timer);
            resolve();
          };
          audio.onerror = () => {
            clearTimeout(timer);
            reject(new Error("Blob audio was blocked or invalid"));
          };
          audio.src = url;
          document.body.append(audio);
        });
        return {
          nonceExecuted:
            document.documentElement.dataset.securityNonceProbe === "executed",
          audioLoaded: audio.readyState >= 1,
        };
      } finally {
        audio.removeAttribute("src");
        audio.load();
        audio.remove();
        URL.revokeObjectURL(url);
      }
    },
    { nonce, audioData },
  );
  assert.deepEqual(result, { nonceExecuted: true, audioLoaded: true });
  await page.getByLabel("File attachments", { exact: true }).setInputFiles({
    name: "csp-preview.png",
    mimeType: "image/png",
    buffer: Buffer.from(imageData, "base64"),
  });
  await until(
    () =>
      page
        .locator('img[src^="blob:"]')
        .evaluateAll(
          (images) =>
            images.length > 0 &&
            images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    "Blob image preview loaded",
    undefined,
    10_000,
  );
  // Yield one rendering frame to deliver queued securitypolicyviolation events.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  );
  assert.deepEqual(
    await page.evaluate(() => window.securityViolations),
    [],
    "Workspace CSP violation",
  );
  return nonce;
}

test(
  "Gateway preserves Workspace CSP, nonce scripts, blob previews and existing conversations",
  {
    timeout: 900_000,
    skip: process.env.ANTNEST_GATEWAY_SECURITY_E2E !== "1",
  },
  async (t) => {
    process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, t.signal]);
    const interrupt = () =>
      abort.abort(new Error("Security headers E2E interrupted"));
    for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
    let before, config, browser, page, client, documentHeaders, failure;
    const candidates = [];
    const problems = [];
    try {
      before = await snapshotEnvironment({ signal });
      config = await configuration(signal);
      const suffix = config.project.slice(-8);
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
          "tests/e2e/edge-gateway/security-headers.compose.yaml",
          ...args,
        ]);
      for (const [service, variable] of [
        ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
        ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
        ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
        ["identity-service", "ANTNEST_SECURITY_E2E_IDENTITY_IMAGE"],
        ["runtime-controller", "ANTNEST_SECURITY_E2E_RC_IMAGE"],
      ]) {
        const image = `antnest/${service}:security-e2e-${suffix}`;
        assert.equal(
          await docker(["image", "ls", "-q", "--filter", `reference=${image}`]),
          "",
          "Candidate tag already exists",
        );
        config.env[variable] = image;
        candidates.push(image);
        console.log(JSON.stringify({ phase: "build", service }));
        await docker(
          [
            "build",
            "-f",
            `services/${service}/Dockerfile`,
            "--label",
            `${ownerLabel}=${config.project}`,
            "-t",
            image,
            ".",
          ],
          true,
        );
      }
      console.log(JSON.stringify({ phase: "start" }));
      await docker(
        compose(["up", "-d", "--wait", "--wait-timeout", "180", "--no-build"]),
        true,
      );
      const fixture = await setup(config, signal);
      client = new GatewayClient(config.gateway);
      await client.request("/api/session/login", { body: member });
      const sessionId = (
        await client.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          {
            status: 201,
            body: {},
          },
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
      await context.addInitScript(() => {
        window.securityViolations = [];
        document.addEventListener("securitypolicyviolation", (event) =>
          window.securityViolations.push({
            directive: event.effectiveDirective,
            disposition: event.disposition,
            blockedURI: event.blockedURI,
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
            policy: event.originalPolicy,
          }),
        );
      });
      page = await context.newPage();
      page.on("pageerror", () => problems.push("pageerror"));
      page.on("websocket", () => problems.push("browser-websocket"));
      const url = `${config.gateway}/workspace/${fixture.agentID}/sessions/${sessionId}`;
      const initialDocument = await page.goto(url, {
        waitUntil: "domcontentloaded",
      });
      documentHeaders = (await initialDocument.headersArray()).filter(
        (header) =>
          ["content-security-policy", "x-content-type-options"].includes(
            header.name.toLowerCase(),
          ),
      );
      assert.equal(
        documentHeaders.filter(
          (header) => header.name.toLowerCase() === "content-security-policy",
        ).length,
        1,
      );
      const composer = page.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(() => composer.isEnabled(), "Composer ready", signal);
      await composer.fill("c4-browser-window-00");
      await composer.press("Enter");
      const completed = page.getByText("c4-browser-window-00 completed", {
        exact: true,
      });
      await completed.waitFor({ timeout: 120_000 });
      await until(() => composer.isEnabled(), "Run complete", signal);
      assert.deepEqual(
        await page.evaluate(() => window.securityViolations),
        [],
      );

      const nonces = [];
      // Navigate and reload the actual existing-conversation route through Gateway.
      for (let pass = 0; pass < 2; pass++) {
        const response =
          pass === 0
            ? await page.goto(url, { waitUntil: "domcontentloaded" })
            : await page.reload({ waitUntil: "domcontentloaded" });
        await completed.waitFor({ timeout: 120_000 });
        await until(
          () => composer.isEnabled(),
          "Existing conversation ready",
          signal,
        );
        assert.equal(
          await page
            .getByRole("status")
            .filter({ hasText: /^Opening conversation$/u })
            .count(),
          0,
        );
        nonces.push(await assertWorkspacePolicy(page, response));
      }
      assert.notEqual(
        nonces[0],
        nonces[1],
        "Document nonce must be unique per request",
      );
      const view = (
        await client.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
        )
      ).body;
      assert.equal(
        view.operations.length,
        1,
        "Reload must not repeat the Prompt",
      );
      assert.equal(view.operations[0].phase, "completed");
      assert.deepEqual(problems, []);
      const evidence = {
        checks: [
          "one-upstream-csp",
          "one-nosniff",
          "nonce-script-executes",
          "blob-image-preview",
          "blob-audio-metadata",
          "existing-conversation-navigation-and-reload",
          "no-suspense-fallback",
          "zero-securitypolicyviolations",
          "fresh-document-nonces",
          "no-prompt-replay",
        ],
      };
      assertSecretFree(JSON.stringify(evidence), [
        member.password,
        "stage3-model-secret",
        ...client.cookies.values(),
      ]);
      writeEvidenceFile(
        process.env.ANTNEST_GATEWAY_SECURITY_E2E_OUTPUT ??
          `artifacts/verification/${config.project}-security-headers`,
        "security-headers.json",
        JSON.stringify(evidence, null, 2),
      );
      console.log(
        JSON.stringify({ phase: "verified", checks: evidence.checks }),
      );
    } catch (error) {
      failure = error;
      if (page && !page.isClosed()) {
        const diagnostics = {
          headers: documentHeaders,
          document: await page.evaluate(() => ({
            violations: window.securityViolations,
            scripts: [...document.scripts].map((script) => ({
              type: script.type,
              nonce: script.nonce,
              src: script.src,
              text:
                script.type === "application/json" || script.src
                  ? undefined
                  : script.textContent.slice(0, 512),
            })),
          })),
        };
        assertSecretFree(JSON.stringify(diagnostics), [
          member.password,
          "stage3-model-secret",
          ...(client?.cookies.values() ?? []),
        ]);
        writeEvidenceFile(
          process.env.ANTNEST_GATEWAY_SECURITY_E2E_OUTPUT ??
            `artifacts/verification/${config.project}-security-headers`,
          "failure.json",
          JSON.stringify(diagnostics, null, 2),
        );
      }
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
          "Security headers E2E cleanup failed",
        );
    }
  },
);
