import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { inspectTemplateTrace } from "./template-trace.mjs";
import { durablePath } from "../../support/storage.mjs";
import { collectObservabilityResolution } from "./resolve-evidence.mjs";
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
      model: { type: "string" },
      image: { type: "string", default: "antnest/antnest-runtime:local" },
      "confirm-development": { type: "boolean", default: false },
    },
  });
  values["env-file"] = durablePath(values["env-file"]);
  assert(
    values["confirm-development"] && values.model,
    "development confirmation and existing model required",
  );
  requireResolveEvidenceDirectory(values["resolve-evidence-directory"]);
  try {
    const settings = parseEnv(readFileSync(values["env-file"], "utf8"));
    const client = new GatewayClient(values.gateway);
    await exerciseTemplate(client, settings, values);
  } catch {
    console.error(
      "Template observation failed; inspect the private evidence directory.",
    );
    process.exitCode = 1;
  }
}

export async function exerciseTemplate(
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
  await client.request("/api/session/login", {
    body: {
      organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
      email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
      password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  try {
    signal?.throwIfAborted();
    const options = {
      status: 201,
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        name: "Template flow acceptance",
        model_profile_id: values.model,
        system_prompt: "Assist the user.",
        max_model_requests: 16,
        runtime: { image_ref: values.image },
      },
    };
    const created = await client.request("/api/admin/templates", options);
    output(
      JSON.stringify({
        template_id: created.body.template_id,
        trace_id: created.traceID,
        state: "created",
      }),
    );
    signal?.throwIfAborted();
    assert.equal(created.body.runtime.image_ref, values.image);
    const replay = await client.request("/api/admin/templates", options);
    signal?.throwIfAborted();
    assert.deepEqual(replay.body, created.body);
    const read = await client.request(
      `/api/admin/templates/${created.body.template_id}`,
    );
    signal?.throwIfAborted();
    assert.equal(read.body.runtime.image_ref, values.image);
    assert.equal(read.body.revision, 1);
    const result = await collect(
      values.jaeger,
      {
        traceID: created.traceID,
        profile: "console",
        resolveTTLMS: config.resolveTTLMS,
        route: "/api/admin/{path...}",
        consoleRoute: "/api/admin/templates",
        method: "POST",
        status: 201,
      },
      {
        directory,
        captureRpcContent: config.captureRpcContent,
        signal,
        inspect: (trace, expected, collection) => {
          const { result, transactions } = inspectTemplateTrace(
            trace,
            expected,
            collection,
          );
          return { ...result, transactions: transactions.length };
        },
      },
    );
    signal?.throwIfAborted();
    const report = {
      ...result,
      template_id: created.body.template_id,
      revision: 1,
      original_image_preserved: true,
      replay_verified: true,
      url: `${values.jaeger}/trace/${created.traceID}`,
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
