import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { collectObservabilityResolution } from "./resolve-evidence.mjs";
import { inspectEgressDatabaseTrace } from "./egress-database-trace.mjs";
import { durablePath } from "../../support/storage.mjs";
import {
  requireResolveEvidenceDirectory,
  resolveObservationConfig,
} from "./resolve-config.mjs";

async function main() {
  const { values } = parseArgs({
    options: {
      gateway: { type: "string", default: "http://127.0.0.1:8090" },
      jaeger: { type: "string", default: "http://127.0.0.1:16686" },
      "env-file": { type: "string", default: ".env" },
      "resolve-evidence-directory": { type: "string" },
      database: { type: "string", default: "antnest_egress" },
      agent: { type: "string" },
      "confirm-development": { type: "boolean", default: false },
    },
  });
  values["env-file"] = durablePath(values["env-file"]);
  assert(
    values["confirm-development"] && values.agent,
    "development confirmation and existing Agent required",
  );
  requireResolveEvidenceDirectory(values["resolve-evidence-directory"]);
  try {
    const settings = parseEnv(readFileSync(values["env-file"], "utf8"));
    const client = new GatewayClient(values.gateway);
    await exerciseEgressDatabase(client, settings, values);
  } catch {
    console.error(
      "Egress database observation failed; inspect the private evidence directory.",
    );
    process.exitCode = 1;
  }
}

export async function exerciseEgressDatabase(
  client,
  settings,
  values,
  {
    collect = collectObservabilityResolution,
    output = console.log,
    signal,
  } = {},
) {
  const directory = requireResolveEvidenceDirectory(
    values["resolve-evidence-directory"],
  );
  const config = resolveObservationConfig(settings);
  signal?.throwIfAborted();
  const { body: login } = await client.request("/api/session/login", {
    body: {
      organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
      email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
      password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  try {
    signal?.throwIfAborted();
    const path = `/api/admin/agents/${encodeURIComponent(values.agent)}/network-policy`;
    const { body: before } = await client.request(path);
    signal?.throwIfAborted();
    assert(["allow_all", "deny_all"].includes(before.action));
    // An unchanged CAS exercises the actual transaction without changing access.
    const saved = await client.request(path, {
      method: "PUT",
      headers: {
        "X-Antnest-Expected-Principal": encodeURIComponent(
          JSON.stringify([
            login.principal.organization_id,
            login.principal.user_id,
          ]),
        ),
      },
      body: {
        action: before.action,
        expected_resource_version: before.resource_version,
      },
    });
    signal?.throwIfAborted();
    assert.equal(saved.body.action, before.action);
    assert.equal(saved.body.resource_version, before.resource_version);
    const { body: after } = await client.request(path);
    signal?.throwIfAborted();
    assert.deepEqual(
      after,
      before,
      "unchanged policy CAS altered network state",
    );
    const result = await collect(
      values.jaeger,
      {
        traceID: saved.traceID,
        profile: "console",
        resolveTTLMS: config.resolveTTLMS,
        route: "/api/admin/{path...}",
        consoleRoute: "/api/admin/agents/{agent_id}/network-policy",
        method: "PUT",
        status: 200,
      },
      {
        directory,
        captureRpcContent: config.captureRpcContent,
        signal,
        inspect: (trace, expected, collection) =>
          inspectEgressDatabaseTrace(trace, values, expected, collection),
      },
    );
    signal?.throwIfAborted();
    const report = {
      ...result,
      url: `${values.jaeger}/trace/${saved.traceID}`,
    };
    assert.equal(
      result.strict_trace,
      "passed",
      "business Trace failed strict validation",
    );
    output(JSON.stringify(report));
    return report;
  } finally {
    await client.request("/api/session", { method: "DELETE", status: 204 });
  }
}

if (import.meta.main) await main();
