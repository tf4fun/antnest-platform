// Opt-in: actual owned Docker workspaces/containers with local Gateway/Jaeger fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runCommand } from "../../support/run-command.mjs";
import { durablePath } from "../../support/storage.mjs";
import { writeDevelopmentJSON } from "../../support/development-configuration.mjs";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import {
  lifecycleKinds,
  publicationTrace,
  retainedAgent,
  lifecycleOrganization,
} from "../../support/fixtures/development-lifecycle.mjs";
import {
  runtimeLossTrace,
  runtimeLossSnapshots,
} from "../../support/fixtures/development-runtime-loss.mjs";
import { lifecycleServer } from "../../support/fixtures/development-lifecycle-server.mjs";
import { inspectLifecycle } from "../../e2e/stage3-base/trace.mjs";
import { inspectPublication } from "../../e2e/development/publication.mjs";
import { tag } from "../../e2e/observability/trace-tree.mjs";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    image: { type: "string" },
    "history-root": { type: "string" },
  },
});
const output = durablePath(values.output);
assert(!existsSync(output), "use fresh output");
assert(values.image, "--image required");
const historyRoot = values["history-root"]
  ? durablePath(values["history-root"])
  : undefined;
const histories = [];
for (const profile of historyRoot ? ["runtime-sync-20260921"] : []) {
  const read = (name) =>
    JSON.parse(readFileSync(durablePath(join(historyRoot, profile, name))));
  const report = read("lifecycle-report.json");
  const snapshots = {
    restart: read("restarted.private.json"),
    compose: read("compose.private.json"),
  };
  const cutoff = Date.parse(snapshots.restart.State.StartedAt) * 1000;
  assert.equal(report.status, "passed");
  assert.deepEqual(
    report.lifecycle.map((x) => x.kind),
    lifecycleKinds,
  );
  assert.equal(report.publication.length, 3);
  const lifecycles = Object.fromEntries(
    report.lifecycle.map((expected) => {
      const trace = read(`lifecycle-${expected.kind}.json`);
      assert.deepEqual(
        inspectLifecycle(trace, expected),
        expected.evidence,
        profile + ": historical lifecycle changed",
      );
      return [expected.kind, { trace, expected }];
    }),
  );
  const publications = report.publication.map((expected) => {
    const trace = read(`publication-${expected.trace_id}.json`);
    const attempt = trace.spans.find(
      (s) => s.operationName === "agent_controller.execution_publication",
    );
    assert.deepEqual(
      inspectPublication(
        trace,
        expected.trace_id,
        tag(attempt, "antnest.organization.id"),
        [],
        () => {},
        cutoff,
      ),
      expected,
    );
    return trace;
  });
  histories.push({ profile, report, lifecycles, publications, snapshots });
}
process.umask(0o077);
mkdirSync(output, { recursive: true, mode: 0o700 });
const write = (name, value) => writeDevelopmentJSON({ output }, name, value);
const docker = (args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const image = docker(["image", "inspect", "--format", "{{.Id}}", values.image]);
const tags = () =>
  docker([
    "image",
    "ls",
    "--no-trunc",
    "--format",
    "{{.Repository}}:{{.Tag}} {{.ID}}",
  ])
    .split("\n")
    .sort();
const before = await snapshotEnvironment();
before.imageTags = tags();
write("environment-before.json", before);
const scope =
  "antnest-runtime-loss-" + randomUUID().replaceAll("-", "").slice(0, 12);
const abort = new AbortController(),
  handlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const fn = () => abort.abort(new Error(signal));
  handlers.set(signal, fn);
  process.on(signal, fn);
}
const checks = [];
try {
  for (const kind of [
    "passed",
    "workspace-link-escape",
    "workspace-cache-link",
    "nonzero-stop",
    "lost-marker",
    "delete-failure",
    ...histories.map((x) => x.profile),
  ]) {
    abort.signal.throwIfAborted();
    const folder = join(output, kind);
    mkdirSync(folder, { mode: 0o700 });
    const agentId = "agent_" + randomUUID().replaceAll("-", ""),
      name = "antnest-runtime-" + agentId,
      volume = "antnest-workspace-" + agentId;
    let containerOwned = false,
      volumeOwned = false,
      fixture;
    const history = histories.find((x) => x.profile === kind);
    const oldAgent = history?.report.lifecycle[0].agentId;
    const rebind = (value) =>
      history
        ? JSON.parse(JSON.stringify(value).replaceAll(oldAgent, agentId))
        : value;
    const lifecycles = history
      ? rebind(history.lifecycles)
      : Object.fromEntries(
          lifecycleKinds.map((k) => [k, runtimeLossTrace(k, agentId)]),
        );
    const publications = history
      ? history.publications
      : [1, 2, 3].map((n) => publicationTrace(n));
    const organization = history
      ? tag(
          publications[0].spans.find(
            (s) => s.operationName === "agent_controller.execution_publication",
          ),
          "antnest.organization.id",
        )
      : lifecycleOrganization;
    const snapshots = history?.snapshots ?? runtimeLossSnapshots(scope);
    const runtimeScope =
      snapshots.compose.services["runtime-controller"].environment
        .ANTNEST_RUNTIME_CONTROLLER_SCOPE;
    let exitedObserved = false,
      absentObserved = false;
    const lossObservations = [];
    const transitions = [],
      containerIDs = [];
    function start() {
      containerOwned = true;
      containerIDs.push(
        docker([
          "run",
          "-d",
          "--name",
          name,
          "--network",
          "none",
          "--label",
          "io.antnest.verification=" + scope,
          "--label",
          "io.antnest.managed=runtime",
          "--label",
          "io.antnest.agent-id=" + agentId,
          "--label",
          "io.antnest.runtime-controller-scope=" + runtimeScope,
          "--label",
          "io.antnest.runtime-generation=" + (containerIDs.length + 1),
          "--mount",
          "type=volume,source=" + volume + ",target=/workspace",
          "--tmpfs",
          "/var/lib/postgresql/data",
          "--entrypoint",
          "sh",
          image,
          "-c",
          `trap 'exit ${kind === "nonzero-stop" && containerIDs.length === 1 ? 7 : 0}' TERM INT; while :; do sleep 1 & wait $!; done`,
        ]),
      );
    }
    function stop() {
      if (!containerOwned) return;
      if (!docker(["ps", "-aq", "--filter", "name=^/" + name + "$"])) {
        containerOwned = false;
        return;
      }
      try {
        docker(["stop", "--time", "5", name]);
        const row = JSON.parse(docker(["inspect", name]))[0];
        lossObservations.push({
          phase: "cleanup_stop",
          container_id: row.Id,
          exit_code: row.State.ExitCode,
          oom_killed: row.State.OOMKilled,
        });
        assert.equal(
          row.State.ExitCode,
          kind === "nonzero-stop" && row.Id === containerIDs[1] ? 7 : 0,
        );
        assert.equal(row.State.OOMKilled, false);
      } finally {
        docker(["rm", "-v", name]);
        containerOwned = false;
      }
    }
    function removeVolume() {
      if (volumeOwned) {
        docker(["volume", "rm", volume]);
        volumeOwned = false;
      }
    }
    try {
      fixture = await lifecycleServer({
        temporaryId: agentId,
        retainedId: retainedAgent,
        organization,
        lifecycles,
        publications,
        agentResponse: (row) => {
          if (fixture.stage !== "enable") return row;
          if (!docker(["ps", "-aq", "--filter", "name=^/" + name + "$"])) {
            assert(
              exitedObserved,
              "Runtime removed before normal exit observation",
            );
            absentObserved = true;
            lossObservations.push({
              phase: "absent",
              container_id: containerIDs[1],
            });
            return {
              ...row,
              runtime_state: "absent",
              failure_code: "runtime_exited",
              executable_execution_revision: null,
            };
          }
          const inspection = JSON.parse(docker(["inspect", name]))[0];
          if (!inspection.State.Running) {
            assert.equal(inspection.State.ExitCode, 0);
            assert.equal(inspection.State.OOMKilled, false);
            exitedObserved = true;
            lossObservations.push({
              phase: "exited",
              container_id: inspection.Id,
              exit_code: inspection.State.ExitCode,
              oom_killed: inspection.State.OOMKilled,
            });
            return {
              ...row,
              runtime_state: "unavailable",
              failure_code: "runtime_exited",
              executable_execution_revision: null,
            };
          }
          return row;
        },
        transition: async (phase, body) => {
          transitions.push(phase);
          if (phase === "create") {
            assert.deepEqual(body, {
              name: "lifecycle-fixture",
              owner_user_id: "user-fixture",
              template_id: "template-fixture",
              template_revision: 1,
            });
            volumeOwned = true;
            docker([
              "volume",
              "create",
              "--label",
              "io.antnest.verification=" + scope,
              "--label",
              "io.antnest.agent-id=" + agentId,
              volume,
            ]);
            start();
            if (kind === "workspace-link-escape")
              docker([
                "exec",
                name,
                "ln",
                "-s",
                "/tmp/escaped",
                "/workspace/marker.txt",
              ]);
            if (kind === "workspace-cache-link")
              docker([
                "exec",
                name,
                "sh",
                "-c",
                "mkdir /workspace/.cache; ln -s /workspace/.cache/escaped /workspace/marker.txt",
              ]);
          } else if (phase === "disable") stop();
          else if (phase === "enable") start();
          else if (phase === "rebuild") {
            assert.deepEqual(body, {
              template_id: "template-fixture",
              template_revision: 1,
            });
            assert(
              exitedObserved && absentObserved,
              "loss was not observed before rebuild",
            );
            assert.equal(
              docker(["ps", "-aq", "--filter", "name=^/" + name + "$"]),
              "",
            );
            containerOwned = false;
            start();
            if (kind === "lost-marker")
              docker([
                "exec",
                name,
                "sh",
                "-c",
                "printf changed > /workspace/marker.txt",
              ]);
          } else if (phase === "delete") {
            if (kind === "delete-failure")
              throw new Error("expected deletion failure");
            if (kind === "workspace-link-escape")
              assert.equal(
                docker([
                  "exec",
                  name,
                  "sh",
                  "-c",
                  "test ! -e /tmp/escaped; printf %s $?",
                ]),
                "0",
              );
            if (kind === "workspace-cache-link")
              assert.equal(
                docker([
                  "exec",
                  name,
                  "sh",
                  "-c",
                  "test ! -e /workspace/.cache/escaped; printf %s $?",
                ]),
                "0",
              );
            stop();
            removeVolume();
          }
        },
      });
      const config = {
        gateway: fixture.origin,
        jaeger: fixture.origin,
        retainedAgentId: fixture.retainedId,
        restartSnapshot: join(folder, "restart.json"),
        composeSnapshot: join(folder, "compose.json"),
        fixtureName: "lifecycle-fixture",
        workspaceFile: "/workspace/marker.txt",
        workspaceMarker: "lifecycle fixture marker",
        envFile: join(folder, "settings.env"),
        secretFile: join(folder, "secret.env"),
        output: join(folder, "evidence"),
      };
      writeDevelopmentJSON(
        { output: folder },
        "restart.json",
        snapshots.restart,
      );
      writeDevelopmentJSON(
        { output: folder },
        "compose.json",
        snapshots.compose,
      );
      writeFileSync(
        config.envFile,
        "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
        { flag: "wx", mode: 0o600 },
      );
      writeFileSync(config.secretFile, "API_KEY=fixture-secret\n", {
        flag: "wx",
        mode: 0o600,
      });
      writeDevelopmentJSON({ output: folder }, "config.json", config);
      const result = await runCommand({
        output: folder,
        name: "cli",
        timeoutMs: 90000,
        graceMs: 10000,
        command: [
          process.execPath,
          "tests/e2e/development/runtime-loss.mjs",
          "--config",
          join(folder, "config.json"),
        ],
      });
      const report = JSON.parse(
        readFileSync(join(config.output, "lifecycle-report.json")),
      );
      const success = kind === "passed" || Boolean(history);
      assert.equal(
        result.exit_code === 0,
        success,
        kind + ": unexpected result; see " + folder,
      );
      assert.equal(report.status, success ? "passed" : "failed");
      if (success) {
        assert.deepEqual(transitions, lifecycleKinds);
        assert.equal(new Set(containerIDs).size, 3);
        assert.equal(
          report.lifecycle.reduce(
            (n, x) => n + x.evidence.platform_absence_probes,
            0,
          ),
          5,
        );
        assert.equal(report.source_absence_404, 1);
        assert.equal(report.lifecycle[3].missingSourceGeneration, 2);
        assert.equal(report.checks.length, 6);
        assert(exitedObserved && absentObserved);
        assert(!containerOwned && !volumeOwned);
        for (const trace of [
          ...publications,
          ...Object.values(lifecycles).map((x) => x.trace),
        ])
          assert.equal(
            fixture.requests.filter(
              (r) => r.url === `/api/traces/${trace.traceID}`,
            ).length,
            3,
          );
        if (history)
          assert.deepEqual(
            JSON.parse(JSON.stringify(report).replaceAll(agentId, oldAgent)),
            history.report,
            kind + ": report changed",
          );
      } else {
        const expected = {
          "workspace-link-escape": /Command failed/,
          "workspace-cache-link": /Command failed/,
          "nonzero-stop": /Expected values to be strictly equal/,
          "lost-marker": /Expected values to be strictly equal/,
          "delete-failure": /HTTP 500/,
        }[kind];
        assert.match(report.failure.message, expected);
        if (kind === "nonzero-stop") {
          assert.equal(report.failure.stage, "normal_runtime_loss");
          assert(!transitions.includes("rebuild"));
          assert(
            lossObservations.some(
              (row) =>
                row.container_id === containerIDs[1] &&
                row.exit_code === 7 &&
                row.oom_killed === false,
            ),
          );
        }
        assert.equal(
          report.cleanup,
          kind === "delete-failure"
            ? "requires_review"
            : "deleted_after_failure",
        );
      }
      writeDevelopmentJSON(
        { output: folder },
        "http-requests.json",
        fixture.requests,
      );
      writeDevelopmentJSON(
        { output: folder },
        "loss-observations.json",
        lossObservations,
      );
      checks.push({
        case: kind,
        exit_code: result.exit_code,
        expected_failure: !success,
        transitions,
        ...(success
          ? {
              lifecycle_traces: 5,
              publications: 3,
              absences: 5,
              source_generation: 2,
              normal_exit_zero_observed: exitedObserved,
              absent_observed_before_rebuild: absentObserved,
              strict_failed: report.lifecycle.filter(
                (x) => x.evidence.strict_trace !== "passed",
              ).length,
            }
          : {}),
        ...(history
          ? {
              historical_report_matches: true,
              rebound: "temporary Agent identity only",
            }
          : {}),
      });
    } finally {
      try {
        if (fixture) await fixture.close();
      } finally {
        try {
          stop();
        } finally {
          removeVolume();
        }
      }
    }
  }
} catch (error) {
  write("failure.json", { message: error.message, stack: error.stack });
  throw error;
} finally {
  const after = await snapshotEnvironment({ before });
  after.imageTags = tags();
  write("environment-after.json", after);
  const isolation = compareEnvironment(before, after);
  write("isolation.json", isolation);
  assert.deepEqual(after.imageTags, before.imageTags);
  assert(isolation.unchanged, "retained environment changed");
  for (const [signal, fn] of handlers) process.removeListener(signal, fn);
}
const result = {
  status: "passed",
  checks,
  scope:
    "Actual owned shell containers and workspace volumes; local Gateway/Jaeger fixtures. An optional original Runtime-loss report/Trace replay preserves warnings and rebinds only temporary Agent identity. Both snapshots retain their original scope/cutoff. Runtime loss uses normal stop, exit zero and observed removal before rebuild. No retained service deployment or real Controller lifecycle business acceptance.",
};
write("result.json", result);
console.log(JSON.stringify(result));
