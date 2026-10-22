import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeArgs,
  dockerClient,
  lines,
} from "../../e2e/lifecycle-closeout/docker.mjs";
import { skillComposeArgs } from "../../e2e/skill-learning/observability-setup.mjs";
import { runCommand } from "../../support/run-command.mjs";
import {
  evidenceDirectory,
  temporaryStorageRoot,
  writeEvidenceFile,
} from "../../support/storage.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { parse, stringify } = requireAcp("yaml");
const nodeImage = "node:24.21.0-bookworm-slim";
const files = [
  "compose.yaml",
  "tests/support/compose.public-development-secrets.yaml",
  "compose.debug.yaml",
  "compose.stage3.yaml",
  "tests/e2e/lifecycle-closeout/compose.yaml",
];
const up = [
  "up",
  "-d",
  "--no-build",
  "--pull",
  "never",
  "--wait",
  "--wait-timeout",
  "2",
];

function assertHealthRejection(error, container) {
  const identities = [
    container.Id,
    container.Id.slice(0, 12),
    container.Name.replace(/^\//u, ""),
  ];
  assert(
    identities.some((id) =>
      error.message.includes(`container ${id} is unhealthy`),
    ),
    "Compose must reject the same inspected container's health gate",
  );
}

function realContract() {
  const original = parse(readFileSync(join(root, "compose.yaml"), "utf8"));
  assert.deepEqual(original.services.jaeger.profiles, ["observability"]);
  assert.deepEqual(original.services["runtime-telemetry-ingress"].profiles, [
    "observability",
  ]);
  assert.deepEqual(original.services["skill-registry"].profiles, ["stage3"]);
  const optional = original.services["skill-registry"].depends_on.jaeger;
  assert.deepEqual(optional, { condition: "service_started", required: false });
  assert.deepEqual(
    original.services["agent-acp-service"].depends_on.jaeger,
    optional,
  );
  const ingress =
    original.services["runtime-telemetry-ingress"].depends_on.jaeger;
  assert.equal(ingress.condition, "service_started");
  assert.notEqual(ingress.required, false);
  return { original, optional, ingress };
}

function fixtureFiles(workspace, project, scenario) {
  const { original, optional, ingress } = realContract();
  const referenced = (args) =>
    args.flatMap((value, index) => (value === "-f" ? [args[index + 1]] : []));
  assert.deepEqual(referenced(composeArgs(project, [])), files);
  assert.deepEqual(referenced(skillComposeArgs(project, [])), files);
  const missingImage = `antnest/skill-observability-unavailable:${project.slice(-8)}`;
  const service = (healthy) => ({
    image: nodeImage,
    command: ["node", "-e", "setInterval(() => {}, 1000)"],
    stop_grace_period: "1s",
    healthcheck: {
      test: ["CMD", "node", "-e", `process.exit(${healthy ? 0 : 1})`],
      interval: "100ms",
      timeout: "1s",
      retries: 1,
    },
  });
  const compose = {
    services: {
      business: {
        ...service(scenario !== "unhealthy-business"),
        profiles: [...original.services["skill-registry"].profiles],
        depends_on: { jaeger: structuredClone(optional) },
        volumes: ["business-data:/data"],
      },
      jaeger: {
        ...service(false),
        image: scenario === "missing-collector" ? missingImage : nodeImage,
        profiles: [...original.services.jaeger.profiles],
      },
      "runtime-telemetry-ingress": {
        ...service(true),
        profiles: [...original.services["runtime-telemetry-ingress"].profiles],
        depends_on: { jaeger: structuredClone(ingress) },
      },
    },
    volumes: { "business-data": {} },
  };
  for (const file of files) {
    const path = join(workspace, file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      stringify(file === "compose.yaml" ? compose : { services: {} }),
      { mode: 0o600 },
    );
  }
  return { compose, missingImage };
}

async function worker(scenario, workspace, output, project) {
  const previousCwd = process.cwd();
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Compose profile acceptance interrupted"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(name),
      ),
    ),
    COMPOSE_DISABLE_ENV_FILE: "1",
  };
  const docker = dockerClient(env, controller.signal, 45000);
  const receipts = [];
  const business = { completed: false };
  let primary;
  let cleanup;
  const invoke = async (label, args, client = docker, timeoutMS = 5000) => {
    const receipt = { label, args, status: "pending" };
    receipts.push(receipt);
    try {
      const raw = await client(args, true, { timeoutMS });
      receipt.status = "completed";
      writeEvidenceFile(
        output,
        `docker-${receipts.length}.private.txt`,
        raw + "\n",
      );
      return raw;
    } catch (error) {
      receipt.status = "failed";
      receipt.error_type = error.name;
      writeEvidenceFile(
        output,
        `docker-${receipts.length}.private.txt`,
        (error.stack ?? String(error)) + "\n",
      );
      throw error;
    }
  };
  const expectedFailure = async (label, args) => {
    let rejected;
    try {
      await invoke(label, args, docker, 8000);
    } catch (error) {
      // Cancellation is never evidence for an expected Compose rejection.
      controller.signal.throwIfAborted();
      if (
        /interrupted or timed out|Docker integration deadline exceeded/iu.test(
          error.message,
        )
      )
        throw error;
      rejected = error;
    }
    assert(rejected, `${label} unexpectedly passed`);
    return rejected;
  };
  const inspectService = async (service) => {
    const ids = lines(
      await invoke(
        `find-${service}`,
        composeArgs(project, ["ps", "-a", "-q", service]),
      ),
    );
    assert.equal(ids.length, 1, `one actual ${service} container required`);
    const rows = JSON.parse(
      await invoke(`inspect-${service}`, ["inspect", ids[0]]),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Config.Labels["com.docker.compose.project"], project);
    assert.equal(rows[0].Config.Labels["com.docker.compose.service"], service);
    return rows[0];
  };
  try {
    const fixture = fixtureFiles(workspace, project, scenario);
    writeEvidenceFile(
      output,
      "fixture.private.json",
      JSON.stringify(fixture, null, 2),
    );
    process.chdir(workspace);
    controller.signal.throwIfAborted();
    const image = await invoke("installed-node-image", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      nodeImage,
    ]);
    assert.match(
      image,
      /^sha256:[a-f0-9]{64}$/u,
      "the fixture requires the already installed Node image",
    );
    if (scenario === "missing-collector") {
      const absent = await expectedFailure("missing-collector-image", [
        "image",
        "inspect",
        fixture.missingImage,
      ]);
      assert.match(absent.message, /No such image|No such object|not found/iu);
      const blocked = await expectedFailure(
        "original-profile-blocks-missing-collector",
        composeArgs(project, up),
      );
      assert.match(blocked.message, /No such image/iu);
      business.original_profile_blocked = true;
      await invoke(
        "skill-business-up",
        skillComposeArgs(project, up),
        docker,
        8000,
      );
      const actual = await inspectService("business");
      assert.equal(actual.State.Running, true);
      assert.equal(actual.State.Health.Status, "healthy");
      business.accepted = true;
      business.health = actual.State.Health.Status;
      business.collector_containers = lines(
        await invoke(
          "collector-remains-absent",
          composeArgs(project, ["ps", "-a", "-q", "jaeger"]),
        ),
      );
      assert.deepEqual(business.collector_containers, []);
    } else if (scenario === "unhealthy-collector") {
      const blocked = await expectedFailure(
        "seed-unhealthy-collector",
        composeArgs(project, [...up, "jaeger"]),
      );
      const before = await inspectService("jaeger");
      assert.equal(before.State.Running, true);
      assert.equal(before.State.Health.Status, "unhealthy");
      assertHealthRejection(blocked, before);
      await invoke(
        "skill-business-up",
        skillComposeArgs(project, up),
        docker,
        8000,
      );
      const actual = await inspectService("business");
      const after = await inspectService("jaeger");
      assert.equal(actual.State.Running, true);
      assert.equal(actual.State.Health.Status, "healthy");
      assert.equal(
        after.Id,
        before.Id,
        "the business path must not replace its unhealthy collector",
      );
      assert.equal(after.State.Running, true);
      assert.equal(after.State.Health.Status, "unhealthy");
      business.accepted = true;
      business.health = actual.State.Health.Status;
      business.collector_unchanged_and_unhealthy = true;
    } else {
      assert.equal(scenario, "unhealthy-business");
      const blocked = await expectedFailure(
        "skill-business-health-still-blocks",
        skillComposeArgs(project, up),
      );
      const actual = await inspectService("business");
      assert.equal(actual.State.Running, true);
      assert.equal(actual.State.Health.Status, "unhealthy");
      assertHealthRejection(blocked, actual);
      business.rejected = true;
      business.health = actual.State.Health.Status;
    }
    controller.signal.throwIfAborted();
    business.completed = true;
  } catch (error) {
    primary = error;
  } finally {
    // Cleanup gets its own signal/deadline even if the owning test was aborted.
    const cleaning = dockerClient(env, undefined, 20000);
    const errors = [];
    cleanup = {
      status: "pending",
      containers: null,
      networks: null,
      volumes: null,
    };
    try {
      // If setup failed before chdir, these paths must still resolve to the
      // disposable fixture, never the repository's full deployment.
      process.chdir(workspace);
      await invoke(
        "cleanup-down",
        composeArgs(project, [
          "down",
          "--remove-orphans",
          "-v",
          "--timeout",
          "1",
        ]),
        cleaning,
        10000,
      );
    } catch (error) {
      errors.push(error);
    }
    for (const [kind, args] of [
      ["containers", ["ps", "-aq"]],
      ["networks", ["network", "ls", "-q"]],
      ["volumes", ["volume", "ls", "-q"]],
    ]) {
      try {
        const remaining = lines(
          await invoke(
            `cleanup-${kind}`,
            [
              ...args,
              "--filter",
              `label=com.docker.compose.project=${project}`,
            ],
            cleaning,
            2500,
          ),
        );
        cleanup[kind] = remaining;
        assert.deepEqual(
          remaining,
          [],
          `owned ${kind} remain after actual Compose down`,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    cleanup.status = errors.length ? "failed" : "verified";
    writeEvidenceFile(
      output,
      "cleanup.private.json",
      JSON.stringify(cleanup, null, 2),
    );
    writeEvidenceFile(
      output,
      "commands.private.json",
      JSON.stringify(receipts, null, 2),
    );
    if (errors.length)
      primary = new AggregateError(
        [...(primary ? [primary] : []), ...errors],
        "profile acceptance or actual cleanup failed",
      );
    process.chdir(previousCwd);
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
  }
  if (controller.signal.aborted && !primary) primary = controller.signal.reason;
  writeEvidenceFile(
    output,
    "result.private.json",
    JSON.stringify(
      {
        scenario,
        project,
        status: primary ? "failed" : "passed",
        business,
        cleanup,
      },
      null,
      2,
    ),
  );
  if (primary) {
    writeEvidenceFile(
      output,
      "failure.private.txt",
      (primary.stack ?? String(primary)) + "\n",
    );
    throw primary;
  }
}

if (process.argv[2] === "--profile-worker") {
  try {
    await worker(...process.argv.slice(3));
  } catch {
    console.error(
      "Compose profile acceptance failed; see its private result and cleanup evidence.",
    );
    process.exitCode = 1;
  }
} else {
  const cancellation = new AbortController();
  const interrupt = () =>
    cancellation.abort(new Error("Compose profile suite interrupted"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
  after(() => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
  });
  for (const [scenario, title] of [
    [
      "missing-collector",
      "missing collector image blocks the original profile but not Skill business startup",
    ],
    [
      "unhealthy-collector",
      "an existing unhealthy collector does not gate Skill business startup",
    ],
    [
      "unhealthy-business",
      "unhealthy Skill business still fails the actual Compose wait gate",
    ],
  ]) {
    test(title, { timeout: 100000, concurrency: false }, async () => {
      cancellation.signal.throwIfAborted();
      const project = `antnest-lifecycle-${randomUUID().slice(0, 8)}`;
      const workspace = mkdtempSync(
        join(temporaryStorageRoot(), "antnest-skill-profile-"),
      );
      const output = evidenceDirectory(
        resolve(
          root,
          "artifacts/verification/skill-observability-profile",
          project,
        ),
      );
      try {
        const execution = await runCommand({
          command: [
            process.execPath,
            script,
            "--profile-worker",
            scenario,
            workspace,
            output,
            project,
          ],
          cwd: root,
          output,
          name: "profile",
          timeoutMs: 60000,
          graceMs: 30000,
        });
        assert.equal(
          execution.exit_code,
          0,
          `actual Compose scenario failed; private evidence: ${output}`,
        );
        assert.equal(execution.complete, true);
        const result = JSON.parse(
          readFileSync(join(output, "result.private.json"), "utf8"),
        );
        assert.equal(result.scenario, scenario);
        assert.equal(result.status, "passed");
        assert.equal(result.business.completed, true);
        assert.deepEqual(result.cleanup, {
          status: "verified",
          containers: [],
          networks: [],
          volumes: [],
        });
        if (scenario === "missing-collector") {
          assert.equal(result.business.original_profile_blocked, true);
          assert.equal(result.business.accepted, true);
          assert.equal(result.business.health, "healthy");
        } else if (scenario === "unhealthy-collector") {
          assert.equal(result.business.accepted, true);
          assert.equal(result.business.collector_unchanged_and_unhealthy, true);
        } else {
          assert.equal(result.business.rejected, true);
          assert.equal(result.business.health, "unhealthy");
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
}
