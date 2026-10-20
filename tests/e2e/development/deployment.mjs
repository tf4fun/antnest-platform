import assert from "node:assert/strict";
import { inspect } from "node:util";
import { c4Configuration } from "../workspace-closeout/c4-configuration.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

export async function resumeDevelopmentController(
  controller,
  { start, inspectContainer, readAgent, signal, poll = until },
) {
  signal?.throwIfAborted();
  await start(controller.Id);
  const healthy = await poll(
    async () => {
      signal?.throwIfAborted();
      const value = await inspectContainer();
      assert.equal(
        value.Id,
        controller.Id,
        "restarted Controller identity changed",
      );
      return (
        value.State.Running && value.State.Health?.Status === "healthy" && value
      );
    },
    "restarted Agent Controller readiness",
    signal,
  );
  const agent = await poll(
    async () => {
      signal?.throwIfAborted();
      const value = await readAgent();
      return (
        value.failure_stage === "runtime_observation" &&
        value.failure_code === "runtime_execution_changed" &&
        value
      );
    },
    "execution identity invalidation",
    signal,
  );
  assert(!agent.executable_execution_revision);
  return { controller: healthy, agent };
}

export async function developmentConfiguration(
  signal,
  allocated,
  { environment = process.env, configuration = c4Configuration } = {},
) {
  assert.match(
    environment.ANTNEST_E2E_CANDIDATE_TAG ?? "",
    /^shell-[a-f0-9]{8}$/u,
    "Development fresh candidate required",
  );
  assert.equal(
    environment.ANTNEST_E2E_RUNTIME_IMAGE,
    `antnest/antnest-runtime:${environment.ANTNEST_E2E_CANDIDATE_TAG}`,
  );
  const config = await configuration(signal, allocated, { environment });
  const compose = config.compose;
  config.compose = (args) =>
    compose(["-f", "tests/e2e/development/compose.yaml", ...args]);
  config.env.ANTNEST_DEVELOPMENT_OTLP_HOST_PORT = "0";
  config.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT = "false";
  return config;
}

export async function developmentEndpoint(config, docker, service, port) {
  const publication = await docker(
    config.compose(["port", service, String(port)]),
  );
  const match = /^127\.0\.0\.1:([1-9][0-9]*)$/u.exec(publication);
  assert(
    match && Number(match[1]) <= 65535,
    "one actual loopback publication required",
  );
  return "http://" + publication;
}

export async function developmentPrivateAccess(config, docker) {
  return {
    credentials: config.credentials,
    acp: await developmentEndpoint(config, docker, "diagnostic-relay", 58081),
    identity: await developmentEndpoint(
      config,
      docker,
      "diagnostic-relay",
      58082,
    ),
    otlp:
      (await developmentEndpoint(
        config,
        docker,
        "development-client-telemetry",
        4318,
      )) + "/v1/traces",
  };
}

export async function runDevelopmentFlow({ report, signal }, actions) {
  const errors = [];
  let config;
  const attempt = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    signal?.throwIfAborted();
    config = await actions.configure((value) => {
      config = value;
    });
    assert(config, "Development configuration required");
    report.project = config.project;
    for (const name of ["deploy", "browser", "drivers"]) {
      signal?.throwIfAborted();
      report.stage = name;
      await actions[name](config, report);
    }
    signal?.throwIfAborted();
    report.admission = await actions.admit(config, report);
    assert.equal(
      report.admission?.passed,
      true,
      "complete Development admission required",
    );
  } catch (error) {
    errors.push(error);
  } finally {
    if (config) {
      await attempt(() => actions.logs(config, report));
      await attempt(async () => {
        report.cleanup = "failed";
        await actions.cleanup(config, report);
        report.cleanup = "verified";
      });
    } else report.cleanup = "not-created";
  }
  Object.defineProperty(report, "developmentErrors", { value: [] });
  const record = () => {
    if (signal?.aborted) errors.push(signal.reason);
    const unique = [...new Set(errors)];
    report.developmentErrors.splice(
      0,
      report.developmentErrors.length,
      ...unique,
    );
    report.private_errors = unique.map((error) => inspect(error, { depth: 8 }));
    report.status =
      !unique.length &&
      report.admission?.passed === true &&
      report.cleanup === "verified"
        ? "passed"
        : "failed";
    report.exit_code = report.status === "passed" ? 0 : 1;
  };
  record();
  const before = report.developmentErrors.length;
  await attempt(() => actions.save(report));
  record();
  if (before !== report.developmentErrors.length) {
    await attempt(() => actions.save(report));
    record();
  }
  return report;
}
