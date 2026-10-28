import assert from "node:assert/strict";
import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dockerClient,
  lines,
  scopeLabel,
} from "../lifecycle-closeout/docker.mjs";
import {
  assertRuntimeStorage,
  waitForDeletedRuntimeResources,
} from "../lifecycle-closeout/failure.mjs";
import { runtimeStatus } from "../lifecycle-closeout/runtime-status.mjs";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
import { grantContainerArgs } from "../../support/service-grants.mjs";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import {
  writeEvidenceFile,
  shellStoragePreflight,
} from "../../support/storage.mjs";
import { inspectRound, inspectBatch } from "./evidence.mjs";
import { phaseTiming, readinessTiming, timingMarkdown } from "./timing.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
process.chdir(root);
process.umask(0o077);
assert.equal(process.env.ANTNEST_E2E_DISPOSABLE, "true");
const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? "", /^antnest-stage3-e2e-[0-9]+$/);
const evidence = `${root}/artifacts/verification/agent-readiness/${project}`;
shellStoragePreflight(evidence);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const save = (name, value) =>
  writeEvidenceFile(
    evidence,
    name,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
  );
const owner = new AbortController(),
  signal = owner.signal;
const deadline = Number(process.env.ANTNEST_E2E_DEADLINE_MS);
assert(Number.isSafeInteger(deadline) && deadline > Date.now());
const stop = () =>
  owner.abort(new Error("readiness integration deadline or interruption"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const timer = setTimeout(stop, deadline - Date.now());
const docker = dockerClient(process.env, signal, deadline - Date.now());
const model = `${project}-readiness-model`,
  client = `${project}-readiness-client`;
const attempted = [],
  rounds = [],
  timedRounds = [];
let baseline, failure, finalModel;
let businessOutcome = "not_reported",
  cleanupOutcome = "not_reported",
  finalCleanupMs = null;
function publishTiming(summary = false) {
  try {
    const report = readinessTiming({
      rounds: timedRounds,
      completed: rounds.length,
      business: businessOutcome,
      cleanup: cleanupOutcome,
      cleanupMs: finalCleanupMs,
    });
    save("timings.json", report);
    if (summary && process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, timingMarkdown(report));
  } catch {
    console.warn(
      "Readiness timing unavailable; business and cleanup admission unchanged",
    );
  }
}
async function inspect(args) {
  return JSON.parse(await docker(args));
}
async function resources(agentId, original) {
  const filter = [
    "--filter",
    `label=${scopeLabel}=${project}`,
    ...(agentId ? ["--filter", `label=io.antnest.agent-id=${agentId}`] : []),
  ];
  let ids = lines(await docker(["ps", "-aq", "--no-trunc", ...filter]));
  let volumes = lines(await docker(["volume", "ls", "-q", ...filter]));
  if (original) {
    const all = lines(await docker(["ps", "-aq", "--no-trunc"]));
    ids = [
      ...new Set([
        ...ids,
        ...original.containers
          .map((row) => row.Id)
          .filter((id) => all.includes(id)),
      ]),
    ];
    const allVolumes = lines(await docker(["volume", "ls", "-q"]));
    volumes = [
      ...new Set([
        ...volumes,
        ...original.volumes.filter((name) => allVolumes.includes(name)),
      ]),
    ];
  }
  return {
    containers: ids.length ? await inspect(["inspect", ...ids]) : [],
    volumes,
  };
}
async function clientCommand(command, index) {
  save(
    `${command}-${index ?? "setup"}.log`,
    await docker(
      [
        "exec",
        client,
        "node",
        "/app/tests/e2e/agent-readiness/client.mjs",
        command,
        ...(index === undefined ? [] : [String(index)]),
      ],
      true,
      { timeoutMS: 210000 },
    ),
  );
}
async function clientJSON(url) {
  return JSON.parse(
    await docker([
      "exec",
      client,
      "node",
      "--input-type=module",
      "-e",
      "const r=await fetch(process.argv[1],{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('fixture HTTP failed');process.stdout.write(await r.text());",
      url,
    ]),
  );
}
async function readRound(index) {
  const name = `round-${index}.json`;
  await docker([
    "cp",
    `${client}:/tmp/agent-readiness/${name}`,
    `${evidence}/${name}`,
  ]);
  return JSON.parse(readFileSync(`${evidence}/${name}`, "utf8"));
}
try {
  baseline = await snapshotEnvironment({ signal, docker });
  save("environment-before.json", baseline);
  assert.deepEqual(await resources(), { containers: [], volumes: [] });
  const ids = lines(
    await docker([
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]),
  );
  const deployed = await inspect(["inspect", ...ids]);
  save("deployment.json", deployed);
  const isProxy = (row) =>
    row.Config.Labels["com.docker.compose.service"] ===
    "publication-delay-proxy";
  inspectDeployment(
    deployed.filter((row) => !isProxy(row)),
    project,
  );
  const proxies = deployed.filter(isProxy);
  assert.equal(proxies.length, 1);
  assert.equal(proxies[0].State.Health.Status, "healthy");
  assert.deepEqual(
    Object.values(proxies[0].HostConfig.PortBindings ?? {}).flat(),
    [],
  );
  assert.deepEqual(Object.keys(proxies[0].NetworkSettings.Networks), [
    `${project}_controller-acp`,
  ]);
  const image = deployed.find(
    (row) =>
      row.Config.Labels["com.docker.compose.service"] === "agent-acp-service",
  ).Image;
  const runtimeImage =
    process.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF ??
    "antnest/antnest-runtime:local";
  const runtimeImageID = (await inspect(["image", "inspect", runtimeImage]))[0]
    .Id;
  attempted.push(model);
  await docker([
    "run",
    "-d",
    "--name",
    model,
    "--label",
    `com.docker.compose.project=${project}`,
    "--network",
    `name=${project}_acp-provider,alias=readiness-model-peer`,
    "--network",
    `name=${project}_controller-provider,alias=readiness-model-peer`,
    "-v",
    `${root}/tests:/app/tests:ro`,
    image,
    "node",
    "/app/tests/e2e/agent-readiness/model.mjs",
  ]);
  const grants = grantContainerArgs(
    {
      credentials: process.env.ANTNEST_SERVICE_AUTH_DIRECTORY,
      env: process.env,
    },
    ["gateway-identity", "console-controller", "agent-ui-acp"],
  );
  const networks = [
    ...new Set([
      ...grants.networks,
      "gateway-ingress",
      "controller-acp",
      "acp-provider",
      "observability",
    ]),
  ];
  attempted.push(client);
  await docker([
    "run",
    "-d",
    "--name",
    client,
    "--label",
    `com.docker.compose.project=${project}`,
    ...networks.flatMap((network) => ["--network", `${project}_${network}`]),
    ...grants.args,
    `--add-host=edge-gateway:${process.env.ANTNEST_SERVICE_NETWORK_PREFIX}.130`,
    "-e",
    `TEST_RUNTIME_IMAGE=${runtimeImage}`,
    "-v",
    `${root}/tests:/app/tests:ro`,
    "-v",
    `${root}/contracts:/app/contracts:ro`,
    "-v",
    `${root}/services/runtime-controller/api/control-contract.json:/app/services/runtime-controller/api/control-contract.json:ro`,
    image,
    "node",
    "-e",
    "const hold=setInterval(()=>{},3600000);for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>clearInterval(hold));",
  ]);
  await clientCommand("seed");
  for (let index = 1; index <= 100; index++) {
    const timing = phaseTiming(),
      recorded = { index, host: timing.values };
    timedRounds.push(recorded);
    try {
      await timing.measure("clientRound", () => clientCommand("round", index));
      let round = await readRound(index);
      recorded.round = round.timing?.round;
      recorded.publication = round.publication;
      const { before, currentStatus } = await timing.measure(
        "resourceInspection",
        async () => {
          const before = await resources(round.agentId);
          assertRuntimeStorage(before, round.agentId);
          assert.equal(before.containers[0].Image, runtimeImageID);
          const currentStatus = await runtimeStatus(
            docker,
            project,
            before.containers[0].Id,
            { signal },
          );
          return { before, currentStatus };
        },
      );
      await timing.measure("clientDelete", () =>
        clientCommand("delete", index),
      );
      round = await readRound(index);
      recorded.deletion = round.timing?.deletion;
      const after = await timing.measure("resourceCleanup", () =>
        waitForDeletedRuntimeResources(() => resources(round.agentId, before), {
          signal,
        }),
      );
      await timing.measure("evidence", async () => {
        round.resources = { before, after, runtimeStatus: currentStatus };
        save(`round-${index}.json`, round);
        inspectRound(round);
        rounds.push(round);
        save("progress.json", { completed: rounds.length, required: 100 });
        console.log(
          `Acknowledged readiness: ${index}/100 first Prompts completed and Runtime resources joined`,
        );
      });
    } finally {
      timing.finish();
      publishTiming();
    }
  }
  finalModel = await clientJSON("http://readiness-model-peer:8080/status");
  const result = inspectBatch({ rounds, model: finalModel });
  assert.deepEqual(await resources(), { containers: [], volumes: [] });
  save("business.json", {
    ...result,
    rounds: rounds.length,
    model: finalModel,
  });
  businessOutcome = "passed";
} catch (error) {
  businessOutcome = "failed";
  failure = error;
  save("failure.json", {
    name: error.name,
    message: error.message,
    completed: rounds.length,
  });
} finally {
  const cleanupStarted = performance.now();
  clearTimeout(timer);
  const cleanup = dockerClient(process.env, undefined, 180000),
    problems = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      problems.push(error);
    }
  };
  for (const name of attempted.toReversed()) {
    const exists = lines(
      await cleanup(["ps", "-aq", "--filter", `name=^/${name}$`]).catch(
        (error) => {
          problems.push(error);
          return "";
        },
      ),
    );
    if (!exists.length) continue;
    if (name === client) {
      await attempt(() =>
        cleanup([
          "cp",
          `${client}:/tmp/agent-readiness`,
          `${evidence}/client-private`,
        ]),
      );
      for (const recorded of timedRounds) {
        if (recorded.round && recorded.deletion) continue;
        try {
          const partial = JSON.parse(
            readFileSync(
              `${evidence}/client-private/round-${recorded.index}.json`,
              "utf8",
            ),
          );
          recorded.round ??= partial.timing?.round;
          recorded.deletion ??= partial.timing?.deletion;
          recorded.publication ??= partial.publication;
        } catch {
          // A command may have failed before writing its first evidence file.
        }
      }
    }
    await attempt(async () =>
      save(
        name === client ? "client.log" : "model.log",
        await cleanup(["logs", name]),
      ),
    );
    await attempt(() => cleanup(["rm", "-f", "-v", name]));
  }
  if (baseline)
    await attempt(async () => {
      const after = await snapshotEnvironment({
        before: baseline,
        docker: cleanup,
      });
      const comparison = compareEnvironment(baseline, after);
      save("environment-after.json", after);
      save("cleanup.json", comparison);
      assert.equal(
        comparison.unchanged,
        true,
        "readiness resources did not return to the deployed baseline",
      );
    });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (problems.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...problems],
      "readiness business or cleanup failed",
    );
  cleanupOutcome = baseline
    ? problems.length
      ? "failed"
      : "passed"
    : "not_reported";
  finalCleanupMs = performance.now() - cleanupStarted;
  publishTiming(true);
}
if (failure) {
  console.error(
    "Acknowledged readiness integration failed; private evidence retained",
  );
  process.exitCode = 1;
}
