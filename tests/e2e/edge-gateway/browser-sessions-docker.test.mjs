import assert from "node:assert/strict";
import { test } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { existsSync, rmSync } from "node:fs";
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
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { setup, until } from "../workspace-closeout/c4-setup.mjs";
import { certificates } from "./tls-certificates.mjs";
import { verifyBrowserSessions } from "./browser-sessions-flow.mjs";
import { startLinkingProvider } from "./oidc-linking-fixture.mjs";
import { verifyOIDCLinking } from "./oidc-linking-flow.mjs";
import { verifyPasswordVerification } from "./password-verification-flow.mjs";
import { verifyLoginAdmission } from "./login-admission-flow.mjs";
import { resolveObservationConfig } from "../observability/resolve-config.mjs";

const ownerLabel = "io.antnest.verification.project";

test(
  "real HTTPS browser sessions span Console and Workspace with expiry and revocation",
  {
    timeout: 900000,
    skip: process.env.ANTNEST_BROWSER_SESSIONS_E2E !== "1",
  },
  async (t) => {
    process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, t.signal]);
    const interrupt = () =>
      abort.abort(new Error("Browser sessions HTTPS E2E interrupted"));
    for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
    const roots = getCACertificates("default");
    const candidates = [],
      candidateIDs = new Map();
    let before,
      config,
      browser,
      linkingProvider,
      admissionProvider,
      certificateDirectory,
      credentialsDirectory,
      failure,
      output;
    try {
      before = await snapshotEnvironment({
        signal,
        images: [
          "admin-console",
          "agent-acp-service",
          "agent-ui",
          "edge-gateway",
          "identity-service",
          "runtime-controller",
          "antnest-runtime",
        ].map((name) => `antnest/${name}:local`),
      });
      config = await configuration(signal, (project) => {
        // The callback precedes credential provisioning. Retain ownership even
        // if configuration fails or is interrupted before returning its config.
        const parent = durablePath(
          `artifacts/verification/authenticated-e2e/${project}`,
        );
        assert.equal(
          existsSync(parent),
          false,
          "fixture credential directory already exists",
        );
        credentialsDirectory = parent;
        output = durablePath(
          process.env.ANTNEST_BROWSER_SESSIONS_E2E_OUTPUT ??
            `artifacts/verification/${project}-browser-sessions`,
        );
      });
      writeEvidenceFile(
        output,
        "environment-before.json",
        JSON.stringify(before, null, 2),
      );
      certificateDirectory = resolve(output, "private-tls");
      const certificate = certificates(certificateDirectory, {
        dnsNames: ["host.docker.internal"],
      });
      config.gateway = config.gateway.replace("http:", "https:");
      linkingProvider = await startLinkingProvider({
        directory: certificateDirectory,
        callback: `${config.gateway}/protocol/oidc/callback`,
        signal,
      });
      admissionProvider = await startLinkingProvider({
        directory: certificateDirectory,
        callback: `${config.gateway}/protocol/oidc/callback`,
        signal,
      });
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
          "-f",
          "tests/e2e/edge-gateway/browser-sessions.compose.yaml",
          "-f",
          "tests/e2e/edge-gateway/password-verification.compose.yaml",
          ...args,
        ]);
      for (const [service, variable] of [
        ["admin-console", "ANTNEST_TLS_E2E_CONSOLE_IMAGE"],
        ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
        ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
        ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
        ["identity-service", "ANTNEST_SECURITY_E2E_IDENTITY_IMAGE"],
        ["runtime-controller", "ANTNEST_SECURITY_E2E_RC_IMAGE"],
      ]) {
        const image = `antnest/${service}:browser-sessions-e2e-${config.project.slice(-8)}`;
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
        const [built] = JSON.parse(await docker(["image", "inspect", image]));
        assert.equal(built.Config.Labels[ownerLabel], config.project);
        candidateIDs.set(image, built.Id);
      }
      writeEvidenceFile(
        output,
        "candidate-images.json",
        JSON.stringify(Object.fromEntries(candidateIDs), null, 2),
      );
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
      const ttlKey = "ANTNEST_EDGE_RESOLVE_CACHE_TTL";
      const ttlValues = gatewayContainer.Config.Env.filter((value) =>
        value.startsWith(ttlKey + "="),
      );
      assert(ttlValues.length <= 1, "duplicate deployed Resolve TTL");
      config.resolveTTLMS = resolveObservationConfig(
        { [ttlKey]: ttlValues[0]?.slice(ttlKey.length + 1) ?? "" },
        {},
      ).resolveTTLMS;
      writeEvidenceFile(
        output,
        "gateway-resolve-config.json",
        JSON.stringify({ resolveTTLMS: config.resolveTTLMS }),
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
        JSON.stringify({ phase: "verify", scope: "two-source-oidc-admission" }),
      );
      const admissionEvidence = await verifyLoginAdmission({
        config,
        fixture,
        provider: admissionProvider,
        certificateDirectory,
        docker,
        compose,
        gatewayContainer,
        output,
        signal,
      });
      writeEvidenceFile(
        output,
        "login-admission.json",
        JSON.stringify(admissionEvidence, null, 2),
      );
      console.log(
        JSON.stringify({ phase: "ready", topology: "reference-proxy" }),
      );
      browser = await chromium.launch({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
          `--ignore-certificate-errors-spki-list=${certificate.spki}`,
          "--host-resolver-rules=MAP host.docker.internal 127.0.0.1",
        ],
      });
      // launch() can finish after an interruption; retain browser ownership and
      // enter cleanup instead of starting more business mutations.
      signal.throwIfAborted();
      const browserAbort = () => void browser.close().catch(() => {});
      signal.addEventListener("abort", browserAbort, { once: true });
      t.after(() => signal.removeEventListener("abort", browserAbort));
      const setIdlePolicy = async (ttl) => {
        config.env.ANTNEST_BROWSER_SESSION_E2E_IDLE_TTL = ttl;
        await docker(
          compose([
            "up",
            "-d",
            "--wait",
            "--no-deps",
            "--no-build",
            "--pull",
            "never",
            "identity-service",
          ]),
          true,
        );
      };
      const passwordEvidence = await verifyPasswordVerification({
        browser,
        config,
        docker,
        compose,
        signal,
        output,
        record: (evidence) =>
          writeEvidenceFile(
            output,
            "password-verification-progress.json",
            JSON.stringify(evidence, null, 2),
          ),
      });
      writeEvidenceFile(
        output,
        "password-verification.json",
        JSON.stringify(passwordEvidence, null, 2),
      );
      const linkingEvidence = await verifyOIDCLinking({
        browser,
        config,
        fixture,
        provider: linkingProvider,
        signal,
        output,
        record: (evidence) =>
          writeEvidenceFile(
            output,
            "oidc-linking-progress.json",
            JSON.stringify({ complete: false, ...evidence }, null, 2),
          ),
      });
      writeEvidenceFile(
        output,
        "oidc-linking.json",
        JSON.stringify({ complete: true, ...linkingEvidence }, null, 2),
      );
      const evidence = await verifyBrowserSessions({
        browser,
        config,
        fixture,
        signal,
        setIdlePolicy,
        output,
        record: (evidence) =>
          writeEvidenceFile(
            output,
            "browser-sessions-progress.json",
            JSON.stringify({ complete: false, ...evidence }, null, 2),
          ),
      });
      writeEvidenceFile(
        output,
        "browser-sessions.json",
        JSON.stringify(evidence, null, 2),
      );
      console.log(JSON.stringify({ phase: "verified" }));
    } catch (error) {
      failure = new Error(
        "Browser sessions HTTPS E2E failed; see private evidence",
      );
      if (output) {
        try {
          writeEvidenceFile(
            output,
            "failure.private.txt",
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          );
        } catch {
          // Diagnostic storage failure must not expose the original exception.
        }
      }
      throw failure;
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
      await attempt(async () => linkingProvider?.close());
      await attempt(async () => admissionProvider?.close());
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
            if (candidateIDs.has(image))
              assert.equal(
                row.Id,
                candidateIDs.get(image),
                "candidate image identity changed before cleanup",
              );
            await docker(["image", "rm", image]);
          });
      }
      if (credentialsDirectory)
        await attempt(async () =>
          rmSync(credentialsDirectory, { recursive: true, force: true }),
        );
      if (certificateDirectory)
        await attempt(async () =>
          rmSync(certificateDirectory, { recursive: true, force: true }),
        );
      if (before)
        await attempt(async () => {
          const after = await snapshotEnvironment({ before });
          const comparison = compareEnvironment(before, after);
          if (output) {
            writeEvidenceFile(
              output,
              "environment-after.json",
              JSON.stringify(after, null, 2),
            );
            writeEvidenceFile(
              output,
              "cleanup.json",
              JSON.stringify(comparison, null, 2),
            );
          }
          assert.equal(comparison.unchanged, true, JSON.stringify(comparison));
          console.log(JSON.stringify({ phase: "cleanup", ...comparison }));
        });
      for (const event of ["SIGINT", "SIGTERM"]) process.off(event, interrupt);
      if (errors.length)
        throw new AggregateError(
          [...(failure ? [failure] : []), ...errors],
          "Browser sessions HTTPS E2E cleanup failed",
        );
    }
  },
);
