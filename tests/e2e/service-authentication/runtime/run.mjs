import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  dockerClient,
  owned,
  scopeLabel,
} from "../../lifecycle-closeout/docker.mjs";
import { candidateCommand } from "../../../support/candidate-images.mjs";
import { runCommand } from "../../../support/run-command.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cacheOnly = process.argv.includes("--managed-caches-only");
const scope = "antnest-native-auth-" + randomUUID();
const evidence = resolve(
  root,
  "artifacts/verification/runtime-instance-admission",
  scope,
);
const directory = resolve(evidence, "credentials");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const image = "antnest/antnest-runtime:auth-instance-" + scope.slice(-8);
const gatedImage = image + "-gated";
const fixtureImage = image + "-fixture";
const network = scope + "-network",
  workspace = scope + "-workspace",
  receiver = scope + "-receiver",
  invalidReceiver = scope + "-invalid-receiver",
  egress = scope + "-egress",
  runtime = scope + "-runtime",
  probeContainer = scope + "-probe";
const agent = "auth-" + scope.slice(-8),
  alias = "antnest-runtime-" + agent;
const hash = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const tokens = Object.fromEntries(
  ["rc", "acp", "wrong", "otherInstance"].map((caller) => [
    caller,
    randomBytes(32).toString("base64url"),
  ]),
);
const callersRaw = JSON.stringify({
  "runtime-controller": [hash(tokens.rc)],
  "agent-acp-service": [hash(tokens.acp)],
});
const key = generateKeyPairSync("ed25519");
const descriptor = {
  connection_id: "rci_" + randomBytes(16).toString("hex"),
  callers_file: "/run/antnest-auth/callers.json",
  receiver_digest: hash(callersRaw),
};
const fixture = {
  agent,
  endpoint: "http://" + alias + ":8093",
  tokens,
  callers_raw: callersRaw,
  signing_key: key.privateKey.export({ format: "pem", type: "pkcs8" }),
};
writeFileSync(resolve(directory, "input.json"), JSON.stringify(fixture), {
  mode: 0o600,
});
const aborted = new AbortController(),
  stop = () => aborted.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
const timer = setTimeout(stop, 1800000);
const docker = dockerClient(process.env, aborted.signal, 1800000);
const labelArgs = ["--label", scopeLabel + "=" + scope];
let complete = false,
  cleaned = false,
  checks = 0,
  spec;
const containers = new Set();
const invoke = async (args, long = false) => {
  if (args[0] === "run") {
    const index = args.indexOf("--name");
    if (index !== -1) containers.add(args[index + 1]);
  }
  return docker(args, long);
};
const prepare = (volume, mode) =>
  invoke([
    "run",
    "--rm",
    "--name",
    scope + "-volume-helper",
    ...labelArgs,
    "--network",
    "none",
    "--entrypoint",
    "python",
    "--mount",
    "type=volume,src=" + volume + ",dst=/run/antnest-auth",
    "--mount",
    "type=bind,src=" + directory + ",dst=/fixture,readonly",
    "--mount",
    "type=bind,src=" +
      resolve(root, "tests/e2e/service-authentication/runtime/bootstrap.py") +
      ",dst=/bootstrap.py,readonly",
    image,
    "/bootstrap.py",
    mode,
  ]);
const envArgs = (values) =>
  Object.entries(values).flatMap(([name, value]) =>
    value === undefined ? [] : ["-e", name + "=" + value],
  );
const validEnv = () => ({
  ANTNEST_RUNTIME_SPEC: JSON.stringify(spec),
  ANTNEST_SERVICE_AUTH_MODE: "token",
  ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
  ANTNEST_SERVICE_AUTH_CALLERS_FILE: "/run/antnest-auth/callers.json",
  OTEL_SDK_DISABLED: "true",
  ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "true",
});
let probeSequence = 0;
let logSequence = 0;
const captureLogs = async (container) => {
  assert(container.startsWith(scope + "-"));
  const name = "container-log-" + logSequence++;
  const result = await runCommand({
    name,
    command: ["docker", "logs", container],
    cwd: root,
    output: evidence,
    timeoutMs: 10000,
    graceMs: 5000,
  });
  assert.equal(result.exit_code, 0, "owned container logs unavailable");
  return readFileSync(resolve(evidence, name + ".log"), "utf8");
};
const probes = async (mode, options = {}) => {
  const name = "probe-" + probeSequence++ + "-" + mode;
  const result = await runCommand({
    name,
    command: [
      "docker",
      "exec",
      probeContainer,
      "node",
      "/probe.mjs",
      mode,
      JSON.stringify(options),
    ],
    cwd: root,
    output: evidence,
    timeoutMs: 60000,
    graceMs: 5000,
  });
  assert.equal(
    result.exit_code,
    0,
    "native " + mode + " probe failed; see private evidence",
  );
  // runCommand preserves both streams privately; the official SDK can emit
  // harmless schema-format warnings on stderr before the final result line.
  const line = readFileSync(resolve(evidence, name + ".log"), "utf8")
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  assert(line, "native probe omitted its result");
  const value = JSON.parse(line);
  assert(Number.isSafeInteger(value.checks) && value.checks >= 0);
  assert(
    Object.keys(value).every((field) =>
      ["checks", "execution_id"].includes(field),
    ),
  );
  checks += value.checks;
  return value;
};

try {
  // In CI the image job ran these gates for the provided images' inputs.
  const build = await runCommand({
    name: "linux-release-build",
    command: candidateCommand({
      name: "antnest-runtime",
      tag: image,
      build: [
        "docker",
        "build",
        "--progress=plain",
        "-f",
        "runtimes/antnest-runtime/Dockerfile",
        "-t",
        image,
        ".",
      ],
    }),
    cwd: root,
    output: evidence,
    timeoutMs: 1200000,
    graceMs: 30000,
  });
  assert.equal(
    build.exit_code,
    0,
    "native Linux release gates failed; see private evidence",
  );
  if (!cacheOnly) {
    const featureBuild = await runCommand({
      name: "linux-feature-build",
      command: candidateCommand({
        name: "antnest-runtime-skill-gate",
        tag: gatedImage,
        build: [
          "docker",
          "build",
          "--progress=plain",
          "--target",
          "e2e",
          "--build-arg",
          "ANTNEST_RUNTIME_FEATURES=skill-maintenance-e2e-gate",
          "-f",
          "runtimes/antnest-runtime/Dockerfile",
          "-t",
          gatedImage,
          ".",
        ],
      }),
      cwd: root,
      output: evidence,
      timeoutMs: 1200000,
      graceMs: 30000,
    });
    assert.equal(
      featureBuild.exit_code,
      0,
      "native Linux feature gates failed; see private evidence",
    );
  }
  const [releasedImage] = JSON.parse(await invoke(["image", "inspect", image]));
  assert.equal(
    releasedImage.Config.Labels["dev.antnest.runtime.test-features"],
    "",
  );
  checks++;
  await invoke(["network", "create", "--internal", ...labelArgs, network]);
  for (const name of [workspace, receiver, invalidReceiver])
    await invoke(["volume", "create", ...labelArgs, name]);
  await prepare(receiver, "valid");
  await invoke([
    "run",
    "-d",
    "--name",
    egress,
    ...labelArgs,
    "--network",
    network,
    "--entrypoint",
    "python",
    "--mount",
    "type=bind,src=" +
      resolve(root, "tests/e2e/antnest-runtime/fixtures/egress_probe.py") +
      ",dst=/probe.py,readonly",
    image,
    "/probe.py",
  ]);
  const [egressDetails] = JSON.parse(await invoke(["inspect", egress]));
  spec = {
    agent_id: agent,
    generation: 1,
    listen: { host: "0.0.0.0", port: 8093 },
    network: {
      packet_contract_revision: 1,
      egress_endpoint: {
        ipv4: egressDetails.NetworkSettings.Networks[network].IPAddress,
        port: 8092,
      },
      tunnel_ipv4: "100.64.0.2",
      resolver_ipv4: "100.64.0.1",
    },
    filesystem: { workspace: "/workspace", system_skills: "/skills" },
    authentication: descriptor,
    skill_maintenance_verifiers: {
      keys: [
        {
          kid: "auth-key",
          algorithm: "Ed25519",
          public_key_base64url: key.publicKey
            .export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("base64url"),
        },
      ],
    },
  };
  await invoke([
    "run",
    "-d",
    "--name",
    runtime,
    ...labelArgs,
    "--network",
    network,
    "--network-alias",
    alias,
    "--cap-drop",
    "ALL",
    "--device",
    "/dev/net/tun",
    "--dns",
    "100.64.0.1",
    "--dns-option",
    "use-vc",
    "--stop-timeout",
    "15",
    ...[
      "CHOWN",
      "DAC_OVERRIDE",
      "KILL",
      "NET_ADMIN",
      "SETGID",
      "SETPCAP",
      "SETUID",
    ].flatMap((capability) => ["--cap-add", capability]),
    "--mount",
    "type=volume,src=" + workspace + ",dst=/workspace",
    "--mount",
    "type=volume,src=" + receiver + ",dst=/run/antnest-auth,readonly",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    ...envArgs(validEnv()),
    image,
  ]);
  await invoke([
    "run",
    "-d",
    "--name",
    probeContainer,
    ...labelArgs,
    "--network",
    network,
    "--entrypoint",
    "node",
    "--mount",
    "type=bind,src=" + directory + ",dst=/fixture,readonly",
    "--mount",
    "type=bind,src=" +
      resolve(root, "tests/e2e/service-authentication/runtime/probe.mjs") +
      ",dst=/probe.mjs,readonly",
    "--mount",
    "type=bind,src=" +
      resolve(root, "services/agent-acp-service/node_modules") +
      ",dst=/node_modules,readonly",
    image,
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  if (!cacheOnly) {
    const current = await probes("ready");
    await probes("matrix");
    await probes("sdk");
    await probes("skills");
    const [nativeContainer] = JSON.parse(await invoke(["inspect", runtime]));
    assert.deepEqual(nativeContainer.NetworkSettings.Ports, {});
    const actualMount = nativeContainer.Mounts.find(
      (mount) => mount.Destination === "/run/antnest-auth",
    );
    assert.equal(actualMount.Name, receiver);
    assert.equal(actualMount.RW, false);
    for (const token of Object.values(tokens))
      assert(!JSON.stringify(nativeContainer.Config.Env).includes(token));
    checks += 4;
    await invoke([
      "exec",
      "--user",
      "1000:1000",
      runtime,
      "python",
      "-c",
      "import os; assert not os.access('/run/antnest-auth/callers.json', os.R_OK); assert not os.access('/run/antnest-auth', os.W_OK)",
    ]);
    checks++;
    await invoke(["restart", "-t", "15", runtime], true);
    await probes("ready");
    await probes("matrix", { previousExecution: current.execution_id });
    await probes("sdk");
    const invalidStartup = async (
      mode,
      env = {},
      changedSpec = spec,
      mount = true,
    ) => {
      await prepare(invalidReceiver, mode);
      const name = scope + "-invalid-" + checks;
      await invoke([
        "run",
        "-d",
        "--name",
        name,
        ...labelArgs,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        ...[
          "CHOWN",
          "DAC_OVERRIDE",
          "KILL",
          "NET_ADMIN",
          "SETGID",
          "SETPCAP",
          "SETUID",
        ].flatMap((capability) => ["--cap-add", capability]),
        ...(mount
          ? [
              "--mount",
              "type=volume,src=" +
                invalidReceiver +
                ",dst=/run/antnest-auth,readonly",
            ]
          : []),
        ...envArgs({
          ...validEnv(),
          ANTNEST_RUNTIME_SPEC: JSON.stringify(changedSpec),
          ...env,
        }),
        image,
      ]);
      for (let attempt = 0; attempt < 50; attempt++) {
        const [details] = JSON.parse(await invoke(["inspect", name]));
        if (!details.State.Running) break;
        await delay(100);
      }
      const [details] = JSON.parse(await invoke(["inspect", name]));
      assert.equal(
        details.State.Running,
        false,
        "invalid bootstrap must not hang",
      );
      assert.equal(details.State.ExitCode, 78);
      const logs = await captureLogs(name);
      const events = logs.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      assert(
        events.some(
          (event) =>
            event["lifecycle.event"] === "process_exit" &&
            event.phase === "bootstrap" &&
            event["bootstrap.stage"] === "runtime_spec",
        ),
        "invalid receiver must fail before network/bootstrap effects",
      );
      for (const token of Object.values(tokens)) assert(!logs.includes(token));
      await invoke(["rm", "-f", "-v", name]);
      checks++;
    };
    for (const mode of [
      "empty",
      "directory-mode",
      "file-mode",
      "owner",
      "link",
      "fifo",
      "extra",
    ])
      await invalidStartup(mode);
    for (const env of [
      { ANTNEST_SERVICE_AUTH_MODE: undefined },
      { ANTNEST_SERVICE_AUTH_MODE: "mtls" },
      { ANTNEST_SERVICE_AUTH_MODE: " token" },
      { ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: undefined },
      { ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "false" },
      { ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: " true" },
      { ANTNEST_SERVICE_AUTH_CALLERS_FILE: "/workspace/callers.json" },
      { ANTNEST_TLS_CA_FILE: "" },
    ])
      await invalidStartup("valid", env);
    await invalidStartup("valid", {}, { ...spec, authentication: undefined });
    await invalidStartup(
      "valid",
      {},
      {
        ...spec,
        authentication: {
          ...descriptor,
          receiver_digest: hash("different receiver"),
        },
      },
    );
    await invalidStartup("valid", {}, spec, false);
    const logs = await captureLogs(runtime);
    for (const token of Object.values(tokens)) assert(!logs.includes(token));
    checks++;
  }
  const fixtureBuild = await runCommand({
    name: "managed-fixture-build",
    command: candidateCommand({
      name: "antnest-runtime-fixture",
      tag: fixtureImage,
      build: [
        "docker",
        "build",
        "--target",
        "build",
        "-f",
        "runtimes/antnest-runtime/Dockerfile",
        "-t",
        fixtureImage,
        ".",
      ],
    }),
    cwd: root,
    output: evidence,
    timeoutMs: 1200000,
    graceMs: 30000,
  });
  assert.equal(fixtureBuild.exit_code, 0, "managed fixture build failed");
  const source = scope + "-managed-source";
  try {
    await invoke([
      "create",
      "--name",
      source,
      ...labelArgs,
      fixtureImage,
      "/bin/true",
    ]);
    await invoke([
      "cp",
      source + ":/tmp/managed-mcp-fixture",
      resolve(directory, "managed-mcp-fixture"),
    ]);
    chmodSync(resolve(directory, "managed-mcp-fixture"), 0o755);
  } finally {
    await invoke(["rm", "-f", "-v", source]);
  }
  await invoke(["stop", "-t", "15", runtime], true);
  await invoke(["rm", "-f", "-v", runtime]);
  spec.mcp_servers = ["alpha", "zeta"].map((id) => ({
    id,
    command: "/opt/managed-mcp-fixture",
    env: { FIXTURE_SECRET: "disk-cache-canary" },
  }));
  const managedRuntimeArgs = [
    "run",
    "-d",
    "--name",
    runtime,
    ...labelArgs,
    "--network",
    network,
    "--network-alias",
    alias,
    "--cap-drop",
    "ALL",
    "--device",
    "/dev/net/tun",
    "--dns",
    "100.64.0.1",
    "--dns-option",
    "use-vc",
    "--stop-timeout",
    "15",
    ...[
      "CHOWN",
      "DAC_OVERRIDE",
      "KILL",
      "NET_ADMIN",
      "SETGID",
      "SETPCAP",
      "SETUID",
    ].flatMap((cap) => ["--cap-add", cap]),
    "--mount",
    "type=volume,src=" + workspace + ",dst=/workspace",
    "--mount",
    "type=volume,src=" + receiver + ",dst=/run/antnest-auth,readonly",
    "--mount",
    "type=bind,src=" +
      resolve(directory, "managed-mcp-fixture") +
      ",dst=/opt/managed-mcp-fixture,readonly",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--tmpfs",
    "/run/antnest-mcp-home:rw,exec,nosuid,nodev,size=64m,mode=0711,uid=0,gid=0",
    ...envArgs(validEnv()),
    image,
  ];
  await invoke(managedRuntimeArgs);
  await probes("ready");
  await probes("managed-caches");
  await invoke(["restart", "-t", "15", runtime], true);
  await probes("ready");
  await probes("managed-caches");
  const goodTmpfs =
    "/run/antnest-mcp-home:rw,exec,nosuid,nodev,size=64m,mode=0711,uid=0,gid=0";
  for (const badTmpfs of [
    goodTmpfs.replace("mode=0711", "mode=0777"),
    goodTmpfs.replace("uid=0", "uid=1000"),
  ]) {
    await invoke(["stop", "-t", "15", runtime], true);
    await invoke(["rm", "-f", "-v", runtime]);
    await invoke(
      managedRuntimeArgs.map((value) =>
        value === goodTmpfs ? badTmpfs : value,
      ),
    );
    let details;
    for (let attempt = 0; attempt < 60; attempt++) {
      [details] = JSON.parse(await invoke(["inspect", runtime]));
      if (!details.State.Running) break;
      await delay(100);
    }
    assert.equal(
      details.State.Running,
      false,
      "unsafe private cache mount must fail closed",
    );
    assert.notEqual(details.State.ExitCode, 0);
    assert(!(await captureLogs(runtime)).includes("disk-cache-canary"));
    checks += 3;
  }
  complete = true;
} finally {
  clearTimeout(timer);
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  const cleanupDocker = dockerClient(process.env, undefined, 180000);
  if (!complete) {
    for (const name of containers) {
      try {
        writeFileSync(
          resolve(evidence, name + ".log"),
          await captureLogs(name),
          { mode: 0o600 },
        );
      } catch {
        /* not created or already removed */
      }
    }
  }
  for (const id of await owned(cleanupDocker, scope, "container")) {
    const [value] = JSON.parse(await cleanupDocker(["inspect", id]));
    assert.equal(value.Config.Labels[scopeLabel], scope);
    if (value.State.Running && value.Config.Entrypoint?.includes("serve"))
      await cleanupDocker(["stop", "-t", "15", id], true);
    await cleanupDocker(["rm", "-f", "-v", id]);
  }
  for (const kind of ["volume", "network"]) {
    for (const id of await owned(cleanupDocker, scope, kind)) {
      const [value] = JSON.parse(await cleanupDocker([kind, "inspect", id]));
      assert.equal(value.Labels[scopeLabel], scope);
      await cleanupDocker([kind, "rm", id]);
    }
  }
  for (const candidate of [image, gatedImage, fixtureImage]) {
    try {
      await cleanupDocker(["image", "rm", candidate]);
    } catch {
      /* absent */
    }
  }
  for (const kind of ["container", "volume", "network"])
    assert.deepEqual(await owned(cleanupDocker, scope, kind), []);
  rmSync(directory, { recursive: true, force: true });
  cleaned = true;
  writeFileSync(
    resolve(evidence, "result.json"),
    JSON.stringify({ project: scope, checks, complete, cleaned }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ project: scope, checks, complete, cleaned }));
}
