import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { fixtureSecret } from "../identity-closeout/oidc-provider.mjs";
import { correlateOIDCRequests } from "../identity-closeout/trace.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { opaqueSubject } from "./oidc-linking-fixture.mjs";
import {
  assertAdmissionReceipts,
  inspectAdmissionTrace,
  admissionPrincipal,
  assertAdmissionArchive,
  attemptAdmissionArchive,
  admissionFailure,
} from "./login-admission-evidence.mjs";

const providerName = "admission-acceptance";
const password = "synthetic-admission-local-password";
export function archiveAdmissionSnapshot(
  directory,
  traceID,
  status,
  text,
  secrets,
) {
  writeEvidenceFile(
    join(directory, "final-traces"),
    `${traceID}.private.json`,
    text,
  );
  assert.equal(status, 200);
  assertAdmissionArchive(JSON.parse(text), traceID, secrets);
}
const rows = (text) =>
  text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

async function fixtureJSON(provider, directory, path, signal) {
  const target = new URL(provider.issuer + path);
  // The host reaches its own fixture listener through loopback. Verify the
  // fixture's certificate name; the issuer seen by Identity remains unchanged.
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      target,
      {
        hostname: "127.0.0.1",
        servername: target.hostname,
        ca: readFileSync(join(directory, "ca.pem")),
        agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: { Host: target.host },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (part) => {
          text += part;
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, 200);
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("admission IdP diagnostic response failed"));
          }
        });
      },
    );
    request.on("error", () =>
      reject(new Error("admission IdP diagnostic request failed")),
    );
    request.end();
  });
}

export async function verifyLoginAdmission({
  config,
  fixture,
  provider,
  certificateDirectory,
  docker,
  compose,
  gatewayContainer,
  output,
  signal,
}) {
  const directory = join(output, "login-admission");
  const evidence = { complete: false, clients: {}, phases: [], receipts: [] };
  const clientIDs = {};
  const startedClients = new Set();
  const secrets = [password, fixtureSecret(1)];
  const errors = [];
  const attempt = (name, action) =>
    attemptAdmissionArchive(errors, name, action);
  let failure;
  const save = () =>
    writeEvidenceFile(
      directory,
      "progress.json",
      JSON.stringify(evidence, null, 2),
    );
  const environment = Object.fromEntries(
    gatewayContainer.Config.Env.map((value) => {
      const split = value.indexOf("=");
      return [value.slice(0, split), value.slice(split + 1)];
    }),
  );
  try {
    // This fixture deliberately uses the deployed 10-minute window and the
    // normal OIDC limit. Shortening either could hide recovery by expiry.
    assert.equal(environment.ANTNEST_EDGE_LOGIN_WINDOW, "10m");
    assert.equal(environment.ANTNEST_EDGE_OIDC_START_SOURCE_MAX, "30");
    const sourceLimit = Number(environment.ANTNEST_EDGE_OIDC_START_SOURCE_MAX);
    const windowMs = 600000;
    const identityHost = new URL(environment.ANTNEST_IDENTITY_SERVICE_URL)
      .hostname;
    for (const client of ["a", "b"]) {
      const id = await docker(compose(["ps", "-q", `login-client-${client}`]));
      assert(id, "missing login admission client container");
      clientIDs[client] = id;
      const [container] = JSON.parse(await docker(["inspect", id]));
      assert.equal(
        container.Config.Labels["com.docker.compose.project"],
        config.project,
      );
      assert.equal(container.State.Running, true);
      assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
      const network =
        container.NetworkSettings.Networks[`${config.project}_tls-ingress`];
      assert(network?.IPAddress, "client is not on the TLS ingress network");
      evidence.clients[client] = network.IPAddress;
    }
    assert.notEqual(evidence.clients.a, evidence.clients.b);
    const created = await fixture.json("/api/admin/directory/users", {
      body: {
        email: "oidc-admission@example.com",
        display_name: "OIDC admission member",
        password,
        role: "member",
      },
    });
    assert.equal(created.user.system_role, "user");
    assert.equal(created.membership.role, "member");
    const registered = await fixture.json(
      "/api/admin/provisioning/oidc-providers",
      {
        body: {
          name: providerName,
          issuer: provider.issuer,
          client_id: "gateway-oidc-test",
          client_secret: fixtureSecret(1),
          scopes: ["openid", "email", "profile"],
          enabled: true,
          link_policy: "none",
          link_domains: [],
          authoritative: false,
        },
      },
    );
    assert.equal(registered.provider.link_policy, "none");
    assert.equal(registered.provider.authoritative, false);
    assert.equal(registered.provider.link_policy_review_required, false);
    assert.deepEqual(registered.provider.link_domains, []);
    const choices = await fixture.json(
      "/api/admin/directory/identity-providers?limit=50",
    );
    const providerID = choices.providers.find(
      (row) => row.name === providerName,
    )?.id;
    assert(providerID);
    const bound = await fixture.json(
      `/api/admin/directory/memberships/${created.membership.id}/external-identities`,
      {
        body: {
          provider_id: providerID,
          subject: opaqueSubject,
          restore_revoked: false,
        },
      },
    );
    assert.equal(bound.binding.subject, opaqueSubject);
    assert.equal(bound.binding.revoked_at, null);
    const expectedPrincipal = admissionPrincipal(
      created,
      await fixture.json("/api/session"),
    );
    const run = async (client, action) => {
      signal.throwIfAborted();
      const input = {
        client,
        action,
        gateway: config.gateway,
        issuer: provider.issuer,
        provider: providerName,
        sourceLimit,
        retryAfter: windowMs / 1000,
        expectedPrincipal,
      };
      startedClients.add(client);
      const raw = await docker([
        "exec",
        "-e",
        `ANTNEST_LOGIN_ADMISSION_CLIENT=${JSON.stringify(input)}`,
        clientIDs[client],
        "node",
        "/login-admission-client.mjs",
      ]);
      const result = JSON.parse(raw);
      assert.equal(result.client, client);
      assert.equal(result.action, action);
      evidence.phases.push(result);
      evidence.receipts.push(...result.receipts);
      save();
      assert.equal(
        result.complete,
        true,
        "login admission client failed; see private partial receipts",
      );
      return result;
    };
    const before = provider.stats();
    const started = performance.now();
    await run("a", "exhaust");
    const login = await run("b", "login");
    assert.deepEqual(login.principal, expectedPrincipal);
    // A must remain exhausted after B has obtained a real authenticated
    // session. This excludes a full table evicting A to make B succeed.
    await run("a", "refused");
    const elapsedMs = performance.now() - started;
    assert.equal(provider.stats().grants, before.grants + 1);
    const gatewayLog = await docker(["logs", gatewayContainer.Id]);
    const identityID = await docker(compose(["ps", "-q", "identity-service"]));
    const identityLog = await docker(["logs", identityID]);
    writeEvidenceFile(directory, "gateway.ndjson", gatewayLog);
    writeEvidenceFile(directory, "identity.ndjson", identityLog);
    evidence.inventory = assertAdmissionReceipts({
      clients: evidence.clients,
      receipts: evidence.receipts,
      sourceLimit,
      windowMs,
      elapsedMs,
      gatewayLogs: rows(gatewayLog),
      identityLogs: rows(identityLog),
    });
    evidence.signed_token_grants = provider.stats().grants - before.grants;
    save();
    const received = await fixtureJSON(
      provider,
      certificateDirectory,
      "/fixture/requests",
      signal,
    );
    const canaries = await fixtureJSON(
      provider,
      certificateDirectory,
      "/fixture/canaries",
      signal,
    );
    secrets.push(...canaries);
    const expectations = correlateOIDCRequests(
      evidence.receipts.map((receipt) => ({
        ...receipt,
        traceID: receipt.trace_id,
        address: evidence.clients[receipt.client],
        identityHost,
        resolveTTLms: config.resolveTTLMS,
        ...(receipt.path === "/protocol/oidc/callback"
          ? {
              oidcRequests: [
                { method: "POST", url: `${provider.issuer}/token` },
                { method: "GET", url: `${provider.issuer}/jwks` },
              ],
            }
          : {}),
      })),
      received,
    );
    evidence.trace_reports = await collectResolveTraceEvidence(
      config.jaeger,
      expectations,
      secrets,
      {
        signal,
        directory: join(directory, "traces"),
        inspect: inspectAdmissionTrace,
      },
    );
    save();
    assertSecretFree(JSON.stringify(evidence), secrets);
    assert(
      evidence.trace_reports.every(
        (report) => report.strict_trace === "passed",
      ),
      "login admission raw trace diagnostics require review",
    );
    evidence.business_complete = true;
    save();
  } catch (error) {
    failure = error;
    await attempt("business-failure", () =>
      writeEvidenceFile(
        directory,
        "business-failure.private.txt",
        error?.stack ?? String(error),
      ),
    );
  } finally {
    // Archive before the parent tears down the stack, including failures and
    // interruption. Diagnostic commands use an independent bounded context.
    const diagnosticSignal = AbortSignal.timeout(90000);
    const clean = dockerClient(config.env, diagnosticSignal, 90000);
    // Killing the host `docker exec` CLI does not kill its container process.
    // Join each owned client first; keep the containers and tmpfs mounted so
    // their final header/body receipts survive interruption for archival.
    for (const [client, id] of Object.entries(clientIDs))
      await attempt(`join-${client}`, async () => {
        const result = JSON.parse(
          await clean([
            "exec",
            id,
            "node",
            "/login-admission-client.mjs",
            "--cancel",
          ]),
        );
        assert.equal(result.joined, true, "actual client process did not join");
      });
    for (const service of ["edge-gateway", "identity-service"])
      await attempt(service, async () => {
        const id = await clean(compose(["ps", "-q", service]));
        assert(id);
        writeEvidenceFile(
          directory,
          `${service}-final.ndjson`,
          await clean(["logs", id]),
        );
      });
    for (const [client, id] of Object.entries(clientIDs))
      if (startedClients.has(client))
        await attempt(`client-${client}`, async () => {
          const text = await clean([
            "exec",
            id,
            "node",
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('/tmp/login-admission-progress.json','utf8'))",
          ]);
          const partial = JSON.parse(text);
          if (
            partial.pending_request ||
            partial.receipts.some((row) => !row.trace_id)
          )
            errors.push(`missing-response-trace-${client}`);
          writeEvidenceFile(
            directory,
            `client-${client}-final.json`,
            JSON.stringify(partial),
          );
          for (const receipt of partial.receipts)
            if (
              !evidence.receipts.some(
                (row) => row.trace_id === receipt.trace_id,
              )
            )
              evidence.receipts.push(receipt);
        });
    for (const traceID of new Set(
      evidence.receipts
        .map((row) => row.trace_id)
        .filter((id) => /^[a-f0-9]{32}$/.test(id ?? "")),
    ))
      await attempt(`trace-${traceID}`, async () => {
        const response = await fetch(`${config.jaeger}/api/traces/${traceID}`, {
          signal: AbortSignal.any([
            diagnosticSignal,
            AbortSignal.timeout(3000),
          ]),
        });
        const text = await response.text();
        archiveAdmissionSnapshot(
          directory,
          traceID,
          response.status,
          text,
          secrets,
        );
      });
    evidence.diagnostics = { complete: errors.length === 0, failed: errors };
    await attempt("progress", save);
    failure = admissionFailure(failure, errors);
  }
  if (failure) throw failure;
  evidence.complete = true;
  save();
  return evidence;
}
