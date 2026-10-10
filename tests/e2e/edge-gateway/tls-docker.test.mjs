import assert from "node:assert/strict";
import { test } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import { writeEvidenceFile, durablePath } from "../../support/storage.mjs";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import { member, setup, until } from "../workspace-closeout/c4-setup.mjs";
import { certificates } from "./tls-certificates.mjs";

const ownerLabel = "io.antnest.verification.project";
const admin = {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};

async function browserLogin(context, gateway, credentials, path) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`${gateway}${path}`);
  for (const [name, value] of Object.entries(credentials))
    await page.locator(`[name="${name}"]`).fill(value);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/session/login" &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  assert.equal(response.status(), 200, "real browser login failed");
  await response.finished();
  await page.locator('[name="password"]').waitFor({ state: "hidden" });
  assert.equal(
    await response.headerValue("strict-transport-security"),
    "max-age=31536000",
  );
  const cookies = await context.cookies();
  for (const name of ["antnest_session", "antnest_csrf"]) {
    const cookie = cookies.find((cookie) => cookie.name === name);
    assert(cookie?.secure, `${name} must retain Secure in the browser`);
    assert.equal(cookie.httpOnly, name === "antnest_session");
    assert.equal(cookie.sameSite, "Lax");
  }
  return page;
}

async function assertAPIOriginAdmission(gateway, cookies, agentID, signal) {
  const origin = new URL(gateway).origin;
  const headers = {
    "Content-Type": "application/json",
    Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
    "X-Antnest-CSRF-Token": cookies.find(({ name }) => name === "antnest_csrf")
      .value,
  };
  let checks = 0;
  const request = async (
    method,
    path,
    extraHeaders,
    status,
    code,
    body = {},
  ) => {
    const response = await fetch(`${gateway}${path}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    const result = await response.json();
    assert.equal(response.status, status, `${method} ${path} Origin admission`);
    if (code) assert.equal(result.code, code);
    if (code === "forbidden")
      assert.equal(result.message, "Request origin is not allowed");
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000",
    );
    checks++;
  };
  for (const [method, path] of [
    ["POST", "/api/session/login"],
    ["POST", "/api/session/login-methods"],
    ["POST", "/api/session/oidc/start"],
    ["DELETE", "/api/session"],
    ["POST", "/api/admin/agents"],
    ["PUT", `/api/admin/agents/${agentID}`],
    ["PATCH", `/api/admin/agents/${agentID}`],
    ["DELETE", `/api/admin/agents/${agentID}`],
    ["POST", `/api/app/workspace/v1/agents/${agentID}/sessions`],
    ["POST", `/api/app/agents/${agentID}/v1/acp`],
    ["DELETE", `/api/app/agents/${agentID}/v1/acp`],
  ])
    await request(method, path, {}, 403, "forbidden");
  for (const evidence of [
    { Origin: "https://foreign.example" },
    { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    { Origin: "" },
    { "Sec-Fetch-Site": "none" },
    { Origin: origin, "Sec-Fetch-Site": "cross-site" },
    { Origin: origin, "Sec-Fetch-Site": "same-site" },
  ])
    await request("POST", "/api/session/login", evidence, 403, "forbidden");
  await request(
    "GET",
    "/api/admin/agents",
    { Origin: "https://foreign.example" },
    403,
    "forbidden",
  );
  await request("GET", "/api/admin/agents", {}, 200);
  await request(
    "POST",
    "/api/session/login-methods",
    { "Sec-Fetch-Site": "same-origin" },
    200,
    undefined,
    { organization_slug: admin.organization_slug },
  );
  await request(
    "POST",
    "/api/admin/agents",
    { Origin: origin, "X-Antnest-CSRF-Token": "incorrect" },
    403,
    "csrf_failed",
  );
  return checks;
}

test(
  "reference HTTPS proxy serves login, Console, Workspace and WSS with independent client admission",
  {
    timeout: 900000,
    skip: process.env.ANTNEST_GATEWAY_TLS_E2E !== "1",
  },
  async (t) => {
    process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, t.signal]);
    const interrupt = () =>
      abort.abort(new Error("Gateway TLS E2E interrupted"));
    for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
    const roots = getCACertificates("default");
    const candidates = [];
    let before,
      config,
      browser,
      connection,
      certificateDirectory,
      failure,
      workspacePage,
      output;
    const browserRequests = [];
    try {
      before = await snapshotEnvironment({ signal });
      config = await configuration(signal);
      output = durablePath(
        process.env.ANTNEST_GATEWAY_TLS_E2E_OUTPUT ??
          `artifacts/verification/${config.project}-tls`,
      );
      certificateDirectory = resolve(output, "private-tls");
      const certificate = certificates(certificateDirectory);
      config.gateway = config.gateway.replace("http:", "https:");
      Object.assign(config.env, {
        ANTNEST_EDGE_PUBLIC_BASE_URL: config.gateway,
        ANTNEST_EDGE_TLS_DIRECTORY: certificateDirectory,
        ANTNEST_EDGE_TLS_HOST_PORT: config.env.ANTNEST_EDGE_HOST_PORT,
        ANTNEST_EDGE_TLS_BIND_ADDRESS: "127.0.0.1",
        ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
        ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
          config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
        ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
          config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(
            ".0/24",
            ".128/25",
          ),
      });
      const docker = dockerClient(config.env, signal, 900000);
      const compose = (args) =>
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/edge-gateway/security-headers.compose.yaml",
          "-f",
          "compose.tls.yaml",
          "-f",
          "tests/e2e/edge-gateway/tls.compose.yaml",
          ...args,
        ]);
      for (const [service, variable] of [
        ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
        ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
        ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
        ["identity-service", "ANTNEST_SECURITY_E2E_IDENTITY_IMAGE"],
        ["runtime-controller", "ANTNEST_SECURITY_E2E_RC_IMAGE"],
      ]) {
        const image = `antnest/${service}:tls-e2e-${config.project.slice(-8)}`;
        assert.equal(
          await docker(["image", "ls", "-q", "--filter", `reference=${image}`]),
          "",
          "candidate tag already exists",
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
      console.log(
        JSON.stringify({ phase: "start", topology: "reference-proxy" }),
      );
      await docker(
        compose(["up", "-d", "--wait", "--wait-timeout", "180", "--no-build"]),
        true,
      );
      const gatewayID = await docker(compose(["ps", "-q", "edge-gateway"]));
      const [gatewayContainer] = JSON.parse(
        await docker(["inspect", gatewayID]),
      );
      assert.deepEqual(
        gatewayContainer.HostConfig.PortBindings ?? {},
        {},
        "cleartext Gateway must not have a host publication",
      );
      assert(
        !gatewayContainer.Config.Env.some(
          (value) =>
            value.startsWith("ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS=") &&
            value !== "ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS=false",
        ),
        "Origin admission must use the default closed setting",
      );
      // Node verifies the private CA and hostname. Chromium pins only this disposable
      // leaf SPKI, avoiding a system trust-store mutation or a global TLS bypass.
      setDefaultCACertificates([...roots, certificate.ca]);
      await until(
        async () => {
          try {
            const response = await fetch(`${config.gateway}/status`, {
              signal: AbortSignal.timeout(2000),
            });
            await response.arrayBuffer();
            return response.status === 200;
          } catch {
            return false;
          }
        },
        "public HTTPS ready",
        signal,
        30000,
      );
      const fixture = await setup(config, signal);
      console.log(
        JSON.stringify({ phase: "ready", topology: "reference-proxy" }),
      );
      browser = await chromium.launch({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [`--ignore-certificate-errors-spki-list=${certificate.spki}`],
      });
      const browserAbort = () => void browser.close();
      signal.addEventListener("abort", browserAbort, { once: true });
      t.after(() => signal.removeEventListener("abort", browserAbort));
      const consoleContext = await browser.newContext();
      const consolePage = await browserLogin(
        consoleContext,
        config.gateway,
        admin,
        "/",
      );
      const consoleResult = await consolePage.evaluate(async () => {
        const response = await fetch("/api/admin/agents");
        return {
          status: response.status,
          hsts: response.headers.get("strict-transport-security"),
          body: await response.json(),
        };
      });
      assert.equal(
        consoleResult.status,
        200,
        "Console admin cookie was not sent",
      );
      assert.equal(consoleResult.hsts, "max-age=31536000");
      assert(JSON.stringify(consoleResult.body).includes(fixture.agentID));
      const originChecks = await assertAPIOriginAdmission(
        config.gateway,
        await consoleContext.cookies(),
        fixture.agentID,
        signal,
      );
      const workspaceContext = await browser.newContext();
      workspacePage = await browserLogin(
        workspaceContext,
        config.gateway,
        member,
        "/workspace/",
      );
      workspacePage.on("response", (response) =>
        browserRequests.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
        }),
      );
      workspacePage.on("requestfailed", (request) =>
        browserRequests.push({
          path: new URL(request.url()).pathname,
          failure: request.failure()?.errorText,
        }),
      );
      const network = await workspaceContext.newCDPSession(workspacePage);
      const eventStreams = new Map();
      const frames = [];
      let promptIntent;
      workspacePage.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/prompts")
        )
          promptIntent = request.postDataJSON().intentId;
      });
      network.on("Network.responseReceived", ({ requestId, response }) => {
        if (
          response.url.startsWith(
            `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}/events`,
          )
        )
          eventStreams.set(requestId, {
            status: response.status,
            type: Object.entries(response.headers).find(
              ([name]) => name.toLowerCase() === "content-type",
            )?.[1],
          });
      });
      network.on(
        "Network.eventSourceMessageReceived",
        ({ requestId, eventName, data }) => {
          if (!eventStreams.has(requestId)) return;
          const event = JSON.parse(data);
          frames.push({
            requestId,
            eventName,
            agentID: event.agentId,
            prompt: Boolean(
              promptIntent && data.includes(JSON.stringify(promptIntent)),
            ),
          });
        },
      );
      await network.send("Network.enable");
      await workspacePage.goto(
        `${config.gateway}/workspace/${fixture.agentID}/`,
      );
      const composer = workspacePage.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(() => composer.isEnabled(), "HTTPS composer ready", signal);
      // The cursor resumes after the initial HTTP View; an idle stream need not
      // emit a snapshot. Wait for the real EventSource response before typing.
      await until(
        () =>
          [...eventStreams.values()].some(
            ({ status, type }) =>
              status === 200 && /^text\/event-stream/u.test(type),
          ),
        "HTTPS SSE connected",
        signal,
      );
      console.log(JSON.stringify({ phase: "workspace-connected" }));
      const frameCount = frames.length;
      await composer.fill("c4-browser-window-00");
      const [promptResponse] = await Promise.all([
        workspacePage.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith("/prompts"),
        ),
        composer.press("Enter"),
      ]);
      assert.equal(
        promptResponse.status(),
        202,
        "HTTPS Prompt admission failed",
      );
      await workspacePage
        .getByText("c4-browser-window-00 completed", { exact: true })
        .waitFor({ timeout: 120000 });
      await until(() => composer.isEnabled(), "HTTPS prompt complete", signal);
      await until(
        () =>
          frames
            .slice(frameCount)
            .some(({ requestId, eventName, agentID, prompt }) => {
              const response = eventStreams.get(requestId);
              return (
                agentID === fixture.agentID &&
                prompt &&
                eventName === "delta" &&
                response.status === 200 &&
                /^text\/event-stream/u.test(response.type)
              );
            }),
        "HTTPS SSE delivered a Prompt delta",
        signal,
      );
      console.log(
        JSON.stringify({ phase: "browser-verified", sseFrames: frames.length }),
      );
      const cookies = await workspaceContext.cookies();
      const cookie = cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");
      connection = connectOwner(
        config.gateway,
        fixture.agentID,
        cookie,
        signal,
      );
      const initialized = await connection.initialize();
      assert(initialized.agentCapabilities);
      const session = await connection.request("new", {
        cwd: "/workspace",
        mcpServers: [],
      });
      assert(session.sessionId, "authenticated WSS session/new failed");
      await connection.request("list", {});
      console.log(JSON.stringify({ phase: "wss-verified" }));
      connection.close();
      connection = undefined;
      const client = new GatewayClient(config.gateway);
      client.cookies = new Map(cookies.map(({ name, value }) => [name, value]));
      await client.request(`/api/app/agents/${fixture.agentID}/v1/acp`, {
        status: 403,
        headers: { Origin: "https://forged.example" },
      });
      const clientResults = [];
      const [clientNetwork] = JSON.parse(
        await docker(["network", "inspect", `${config.project}_tls-ingress`]),
      );
      const subnet = clientNetwork.IPAM.Config.find(({ Subnet }) =>
        Subnet.includes("."),
      )?.Subnet;
      assert(subnet, "client network must have an IPv4 subnet");
      const networkPrefix = subnet
        .split("/")[0]
        .split(".")
        .slice(0, 3)
        .join(".");
      for (const role of ["attacker", "victim"]) {
        const result = await docker([
          "run",
          "--rm",
          "--label",
          `com.docker.compose.project=${config.project}`,
          "--network",
          `${config.project}_tls-ingress`,
          "--ip",
          `${networkPrefix}.${role === "attacker" ? 10 : 11}`,
          "--mount",
          `type=bind,src=${resolve("tests")},dst=/tests,readonly`,
          "--mount",
          `type=bind,src=${certificateDirectory},dst=/tls,readonly`,
          "--env",
          "NODE_EXTRA_CA_CERTS=/tls/ca.pem",
          "--env",
          `TLS_TEST_CLIENT=${role}`,
          "--env",
          "TLS_TEST_SOURCE_LIMIT=6",
          "node:24.21.0-bookworm-slim",
          "node",
          "/tests/e2e/edge-gateway/tls-client.mjs",
        ]);
        clientResults.push(JSON.parse(result));
      }
      assert.notEqual(
        clientResults[0].address,
        clientResults[1].address,
        "acceptance must use two actual client addresses",
      );
      const logs = await docker(["logs", gatewayID]);
      for (const { address } of clientResults)
        assert(
          logs.includes(`"client_address":"${address}"`),
          "Gateway logs must record the resolved client address",
        );
      const evidence = {
        checks: [
          "private-ca-and-hostname-verified",
          "gateway-cleartext-port-unpublished",
          "browser-login-secure-cookies",
          "console-admin-call",
          "workspace-prompt-and-sse",
          "authenticated-wss-initialize-and-session",
          "wrong-origin-rejected",
          "api-origin-admission-before-routing",
          "same-origin-fetch-metadata",
          "csrf-independent-of-origin",
          "hsts",
          "spoofed-forwarding-headers-ignored",
          "distinct-proxy-client-rate-limits",
          "resolved-client-address-logs",
        ],
        clients: clientResults,
        originChecks,
        sseFrames: frames.length,
      };
      assertSecretFree(JSON.stringify(evidence), [
        member.password,
        admin.password,
        ...cookies.map(({ value }) => value),
      ]);
      writeEvidenceFile(output, "tls.json", JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ phase: "verified", ...evidence }));
    } catch (error) {
      failure = error;
      if (workspacePage && !workspacePage.isClosed()) {
        const diagnostics = {
          requests: browserRequests,
          page: await workspacePage.locator("body").innerText(),
        };
        const cookies = await workspacePage.context().cookies();
        assertSecretFree(JSON.stringify(diagnostics), [
          member.password,
          admin.password,
          "stage3-model-secret",
          ...cookies.map(({ value }) => value),
        ]);
        writeEvidenceFile(
          output,
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
      await attempt(async () => connection?.close());
      await attempt(async () => browser?.close());
      setDefaultCACertificates(roots);
      if (config) {
        await attempt(() => cleanup(config));
        const docker = dockerClient(config.env, undefined, 180000);
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
            const [row] = JSON.parse(await docker(["image", "inspect", image]));
            assert.equal(
              row.Config.Labels[ownerLabel],
              config.project,
              "candidate cleanup ownership changed",
            );
            await docker(["image", "rm", image]);
          });
      }
      if (certificateDirectory)
        await attempt(async () =>
          rmSync(certificateDirectory, { recursive: true, force: true }),
        );
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
          "Gateway TLS E2E cleanup failed",
        );
    }
  },
);
