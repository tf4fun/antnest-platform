// Opt-in migration evidence: real owned Docker containers/volumes; local Gateway/Jaeger.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
  recoveryAgent,
  recoveryAgentState,
  recoveryTrace,
} from "../../support/fixtures/development-recovery.mjs";
import { inspectLifecycle } from "../../e2e/stage3-base/trace.mjs";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    image: { type: "string" },
    "history-root": { type: "string" },
  },
});
const output = durablePath(values.output);
assert(!existsSync(output), "use a fresh output directory");
assert(values.image, "--image required");
const historyRoot = values["history-root"]
  ? durablePath(values["history-root"])
  : undefined;
const historical = historyRoot
  ? (() => {
      const folder = join(historyRoot, "controller-sync-20260921");
      const read = (name) =>
        JSON.parse(readFileSync(durablePath(join(folder, name))));
      const report = read("recovery-report.json"),
        trace = read("recovery-trace.private.json");
      assert.equal(report.lifecycle.length, 1);
      const expected = report.lifecycle[0];
      assert.deepEqual(
        inspectLifecycle(trace, expected),
        expected.evidence,
        "original recovery Trace changed",
      );
      const archive = durablePath(join(folder, "workspace-before.tar"));
      // This particular historical archive has only directories and one ordinary file.
      const listing = execFileSync("tar", ["-tvf", archive], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert(
        listing
          .trim()
          .split("\n")
          .every((row) => /^[d-]/u.test(row)),
        "archive must have only directories/files",
      );
      const paths = execFileSync("tar", ["-tf", archive], {
        encoding: "utf8",
        timeout: 10000,
      })
        .trim()
        .split("\n");
      assert(
        paths.every(
          (path) => path.startsWith("./") && !path.split("/").includes(".."),
        ),
        "archive paths must stay in workspace",
      );
      return {
        report,
        trace,
        original: read("agent-startup.private.json"),
        archive: readFileSync(archive),
        manifest: readFileSync(
          durablePath(join(folder, "workspace-before.sha256")),
          "utf8",
        ),
      };
    })()
  : undefined;
process.umask(0o077);
mkdirSync(output, { recursive: true, mode: 0o700 });
const write = (name, value) => writeDevelopmentJSON({ output }, name, value);
const docker = (args, input) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    input,
    timeout: 30000,
  }).trim();
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
  "antnest-recovery-" + randomUUID().replaceAll("-", "").slice(0, 12);
const abort = new AbortController(),
  handlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => abort.abort(new Error(signal));
  handlers.set(signal, handler);
  process.on(signal, handler);
}
const checks = [];
try {
  for (const kind of [
    "passed",
    "unchanged-container",
    "changed-volume",
    "changed-bytes",
    "unreadable-file",
    "unreadable-directory",
    "bind-mount",
    "readonly-volume",
    "nested-mount",
    ...(historical ? ["history"] : []),
  ]) {
    abort.signal.throwIfAborted();
    const folder = join(output, kind);
    mkdirSync(folder, { mode: 0o700 });
    const agentId = "agent_" + randomUUID().replaceAll("-", ""),
      name = "antnest-runtime-" + agentId;
    const volume = scope + "-" + kind,
      replacement = volume + "-replacement";
    const volumes = [],
      containers = new Set();
    const isHistorical = kind === "history";
    const savedAgent = isHistorical
      ? historical.report.lifecycle[0].agentId
      : recoveryAgent;
    const rebind = (value) =>
      JSON.parse(JSON.stringify(value).replaceAll(savedAgent, agentId));
    const raw = isHistorical ? historical.trace : recoveryTrace().trace;
    const trace = rebind(raw);
    const expected = isHistorical
      ? historical.report.lifecycle[0]
      : recoveryTrace().expected;
    const original = isHistorical
      ? rebind(historical.original)
      : rebind(recoveryAgentState());
    const recovered = {
      ...rebind(recoveryAgentState(true)),
      agent_id: agentId,
      configuration: structuredClone(original.configuration),
    };
    const content = "recovery fixture\n";
    const manifest = isHistorical
      ? historical.manifest
      : createHash("sha256").update(content).digest("hex") + "  ./marker.txt\n";
    const requests = [];
    let rebuilt = false,
      samples = 0,
      server;
    function createVolume(value) {
      docker([
        "volume",
        "create",
        "--label",
        "io.antnest.verification=" + scope,
        value,
      ]);
      volumes.push(value);
    }
    function start(selectedVolume, special = false) {
      const mount =
        kind === "bind-mount" && special
          ? ["--mount", "type=bind,source=" + folder + ",target=/workspace"]
          : [
              "--mount",
              "type=volume,source=" +
                selectedVolume +
                ",target=/workspace" +
                (kind === "readonly-volume" && special ? ",readonly" : ""),
            ];
      const extra =
        kind === "nested-mount" && special
          ? ["--tmpfs", "/workspace/nested"]
          : [];
      containers.add(name);
      return docker([
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--user",
        "65534:65534",
        "--label",
        "io.antnest.verification=" + scope,
        "--label",
        "io.antnest.managed=runtime",
        "--label",
        "io.antnest.agent-id=" + agentId,
        "--label",
        "io.antnest.runtime-controller-scope=" + scope,
        ...mount,
        ...extra,
        "--entrypoint",
        "sh",
        image,
        "-c",
        "trap 'exit 0' TERM INT; while :; do sleep 1 & wait $!; done",
      ]);
    }
    function stop() {
      docker(["stop", "--time", "5", name]);
      assert.equal(
        docker(["inspect", "--format", "{{.State.ExitCode}}", name]),
        "0",
        "fixture must stop normally",
      );
      docker(["rm", "-v", name]);
      containers.delete(name);
    }
    try {
      createVolume(volume);
      start(volume);
      if (isHistorical)
        docker(
          [
            "exec",
            "-i",
            "-u",
            "0",
            name,
            "tar",
            "-xf",
            "-",
            "-C",
            "/workspace",
          ],
          historical.archive,
        );
      else
        docker(
          [
            "exec",
            "-i",
            "-u",
            "0",
            name,
            "sh",
            "-c",
            "cat > /workspace/marker.txt; chmod 644 /workspace/marker.txt",
          ],
          content,
        );
      // The archived file is private to its original UID. This isolated checker
      // runs unprivileged so permission failures can be tested; retain bytes,
      // while granting this fixture user read/search access before those cases.
      docker(["exec", "-u", "0", name, "chmod", "-R", "a+rX", "/workspace"]);
      if (["bind-mount", "readonly-volume", "nested-mount"].includes(kind)) {
        stop();
        start(volume, true);
      }
      const sourceID = docker(["inspect", "--format", "{{.Id}}", name]);
      server = createServer(async (request, response) => {
        try {
          let body = "";
          for await (const chunk of request) body += chunk;
          requests.push({ url: request.url, method: request.method, body });
          let value,
            status = 200;
          if (request.url === "/api/session/login") value = {};
          else if (request.url === `/api/admin/agents/${agentId}/rebuild`) {
            assert(!rebuilt, "duplicate rebuild");
            assert.deepEqual(JSON.parse(body), {
              template_id: original.configuration.template.template_id,
              template_revision: original.configuration.template.revision,
            });
            if (kind !== "unchanged-container") {
              stop();
              if (kind === "changed-volume") createVolume(replacement);
              start(kind === "changed-volume" ? replacement : volume);
            }
            if (kind === "changed-bytes")
              docker([
                "exec",
                "-u",
                "0",
                name,
                "sh",
                "-c",
                "printf changed >> /workspace/marker.txt",
              ]);
            if (kind === "unreadable-file")
              docker([
                "exec",
                "-u",
                "0",
                name,
                "chmod",
                "000",
                "/workspace/marker.txt",
              ]);
            if (kind === "unreadable-directory")
              docker([
                "exec",
                "-u",
                "0",
                name,
                "sh",
                "-c",
                "mkdir /workspace/hidden; chmod 700 /workspace/hidden",
              ]);
            rebuilt = true;
            value = { request_id: expected.requestId };
            status = 202;
          } else if (request.url === `/api/admin/agents/${agentId}`)
            value = rebuilt ? recovered : original;
          else if (
            request.url === `/api/admin/operations/${expected.requestId}`
          )
            value = { state: "completed" };
          else if (request.url === `/api/app/agents/${agentId}/state`)
            value = {
              agent_id: agentId,
              availability: "ready",
              active_session_id: null,
            };
          else if (request.url === `/api/traces/${trace.traceID}`) {
            samples++;
            value = { data: [trace] };
          } else {
            status = 404;
            value = {};
          }
          response.writeHead(status, {
            "content-type": "application/json",
            "x-antnest-trace-id": trace.traceID,
          });
          response.end(JSON.stringify(value));
        } catch (error) {
          response.writeHead(500);
          response.end(JSON.stringify({ error: error.message }));
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = "http://127.0.0.1:" + server.address().port;
      const config = {
        gateway: origin,
        jaeger: origin,
        retainedAgentId: agentId,
        runtimeContainerPrefix: "antnest-runtime-",
        runtimeControllerScope: scope,
        workspaceVolume: volume,
        workspaceManifest: join(folder, "workspace.sha256"),
        envFile: join(folder, "settings.env"),
        secretFile: join(folder, "secret.env"),
        output: join(folder, "evidence"),
      };
      writeFileSync(config.workspaceManifest, manifest, {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(
        config.envFile,
        "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
        { flag: "wx", mode: 0o600 },
      );
      writeFileSync(config.secretFile, "API_KEY=fixture-secret\n", {
        flag: "wx",
        mode: 0o600,
      });
      const configFile = join(folder, "config.json");
      writeDevelopmentJSON({ output: folder }, "config.json", config);
      const result = await runCommand({
        output: folder,
        name: "cli",
        timeoutMs: 60000,
        graceMs: 5000,
        command: [
          process.execPath,
          "tests/e2e/development/recover.mjs",
          "--config",
          configFile,
        ],
      });
      const report = JSON.parse(
        readFileSync(join(config.output, "recovery-report.json")),
      );
      writeDevelopmentJSON({ output: folder }, "http-requests.json", requests);
      const success = ["passed", "history"].includes(kind);
      assert.equal(
        result.exit_code === 0,
        success,
        kind + ": unexpected exit; see " + folder,
      );
      assert.equal(report.status, success ? "passed" : "failed");
      if (success) {
        assert.equal(samples, 3);
        assert.equal(report.lifecycle.length, 1);
        assert.notEqual(
          sourceID,
          docker(["inspect", "--format", "{{.Id}}", name]),
        );
        assert.deepEqual(
          JSON.parse(
            readFileSync(join(config.output, "recovery-trace.private.json")),
          ),
          trace,
        );
        if (isHistorical) {
          const restored = JSON.parse(
            JSON.stringify(report).replaceAll(agentId, savedAgent),
          );
          assert.deepEqual(
            restored,
            historical.report,
            "historical recovery report changed",
          );
        }
      } else {
        const message = {
          "unchanged-container": /strictly unequal/,
          "changed-volume": /workspace volume mismatch/,
          "changed-bytes": /Expected values to be strictly equal/,
          "unreadable-file": /Command failed/,
          "unreadable-directory": /Command failed/,
          "bind-mount": /named volume/,
          "readonly-volume": /writable/,
          "nested-mount": /nested mounts/,
        }[kind];
        assert.match(report.failure.message, message, kind);
        if (["bind-mount", "readonly-volume", "nested-mount"].includes(kind))
          assert.equal(rebuilt, false);
      }
      checks.push({
        case: kind,
        exit_code: result.exit_code,
        expected_failure: !success,
        trace_samples: samples,
        ...(success
          ? { strict_trace: report.lifecycle[0].evidence.strict_trace }
          : {}),
        ...(isHistorical
          ? {
              original_trace_and_report_match: true,
              workspace:
                "restored original tar and exact original SHA-256 manifest",
              rebound: "Agent identity only",
            }
          : {}),
      });
    } finally {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      for (const container of containers) {
        if (docker(["ps", "-aq", "--filter", "name=^/" + container + "$"]))
          stop();
      }
      for (const value of [...volumes].reverse())
        docker(["volume", "rm", value]);
    }
  }
} catch (error) {
  write("failure.json", {
    type: error.name,
    message: error.message,
    stack: error.stack,
  });
  throw error;
} finally {
  const after = await snapshotEnvironment({ before });
  after.imageTags = tags();
  write("environment-after.json", after);
  const isolation = compareEnvironment(before, after);
  write("isolation.json", isolation);
  assert.deepEqual(after.imageTags, before.imageTags);
  assert(isolation.unchanged, "retained environment changed");
  for (const [signal, handler] of handlers)
    process.removeListener(signal, handler);
}
const result = {
  status: "passed",
  checks,
  scope:
    "Actual owned Docker Runtime replacement and RW workspace volumes; local Gateway/Jaeger adapters. Historical Trace/report are checked unchanged, then only Agent identity is rebound for isolated CLI replay. No retained Agent rebuild or deployed-service business acceptance.",
};
write("result.json", result);
console.log(JSON.stringify(result));
