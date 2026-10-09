import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { candidateCommand } from "../../support/candidate-images.mjs";
import { runCommand } from "../../support/run-command.mjs";
import {
  createRuntimeReceiver,
  freeLoopbackPort,
  installRuntimeReceiver,
} from "../../support/runtime-receiver-fixture.mjs";

const prefix = `antnest-temporary-${randomUUID().slice(0, 8)}`;
const build = process.argv.includes("--build");
const image = build
  ? `antnest/antnest-runtime:temporary-${prefix.slice(-8)}`
  : (process.env.ANTNEST_RUNTIME_TEST_IMAGE ?? "antnest/antnest-runtime:local");
const output = "artifacts/verification/skill-discovery-d4-20261001";
mkdirSync(output, { recursive: true });
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const docker = dockerClient(process.env, controller.signal, 1200000);
const network = `${prefix}-network`,
  volume = `${prefix}-workspace`,
  runtime = `${prefix}-runtime`,
  egress = `${prefix}-egress`;
const authVolume = `${prefix}-receiver`,
  helperImage = `${prefix}:readiness`,
  authDirectory = fileURLToPath(
    new URL(`../../../${output}/${prefix}-auth`, import.meta.url),
  );
const authentication = createRuntimeReceiver(authDirectory);
// The ACP credential is admitted on every Runtime route this runner uses.
const serviceAuthorization = {
  "Antnest-Service-Authorization": readFileSync(
    `${authDirectory}/mcp.headers`,
    "utf8",
  )
    .trim()
    .replace(/^Antnest-Service-Authorization: /, ""),
};
const label = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const key = generateKeyPairSync("ed25519"),
  nextKey = generateKeyPairSync("ed25519");
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const Ajv = require("ajv");
const validateWire = new Ajv({ strict: true }).compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/runtime/temporary-skills.schema.json",
        import.meta.url,
      ),
    ),
  ),
);

function archive(name = "temporary-check") {
  const files = [
    {
      path: "SKILL.md",
      data: Buffer.from(
        `---\nname: ${name}\ndescription: A temporary executable check\n---\nRun scripts/check.sh in this package.\n`,
      ),
      executable: false,
    },
    {
      path: "scripts/background.sh",
      data: Buffer.from(
        "#!/bin/sh\nsleep 10 &\necho $! > /workspace/temp-script-bg.pid\n",
      ),
      executable: true,
    },
    {
      path: "scripts/check.sh",
      data: Buffer.from("#!/bin/sh\nprintf 'temporary-check-ok\\n'\n"),
      executable: true,
    },
  ];
  const local = [],
    central = [],
    canonical = [Buffer.from("antnest-skill-manifest-v1\0")];
  let offset = 0;
  for (const file of files) {
    const path = Buffer.from(file.path),
      crc = crc32(file.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(file.data.length, 18);
    head.writeUInt32LE(file.data.length, 22);
    head.writeUInt16LE(path.length, 26);
    local.push(head, path, file.data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(file.data.length, 20);
    record.writeUInt32LE(file.data.length, 24);
    record.writeUInt16LE(path.length, 28);
    record.writeUInt32LE(
      ((file.executable ? 0o100755 : 0o100644) << 16) >>> 0,
      38,
    );
    record.writeUInt32LE(offset, 42);
    central.push(record, path);
    offset += head.length + path.length + file.data.length;
    const pathLength = Buffer.alloc(4),
      size = Buffer.alloc(8);
    pathLength.writeUInt32BE(path.length);
    size.writeBigUInt64BE(BigInt(file.data.length));
    canonical.push(
      pathLength,
      path,
      size,
      createHash("sha256").update(file.data).digest(),
      Buffer.from([Number(file.executable)]),
    );
  }
  const directory = Buffer.concat(central),
    ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50);
  ending.writeUInt16LE(files.length, 8);
  ending.writeUInt16LE(files.length, 10);
  ending.writeUInt32LE(directory.length, 12);
  ending.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, directory, ending]);
  return {
    bytes,
    content_digest: label(Buffer.concat(canonical)),
    artifact_digest: label(bytes),
  };
}
function multipart(metadata, bytes) {
  return Buffer.concat([
    Buffer.from(
      '--temporary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n',
    ),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(
      '\r\n--temporary\r\nContent-Disposition: form-data; name="artifact"\r\n\r\n',
    ),
    bytes,
    Buffer.from("\r\n--temporary--\r\n"),
  ]);
}
function authorization(
  body,
  executionId,
  action,
  requestId,
  runId,
  signing = key,
  kid = "key-1",
  agent = "agent-temporary",
) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ version: 1, algorithm: "Ed25519", kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      organization_id: "org-temporary",
      agent_id: agent,
      execution_id: executionId,
      job_id: runId,
      generation: 1,
      action,
      request_id: requestId,
      body_sha256: label(body),
      issued_at: now,
      expires_at: now + 60,
    }),
  ).toString("base64url");
  return `AntnestMaintenance ${header}.${payload}.${sign(null, Buffer.from(`antnest-skill-maintenance-v1\n${header}.${payload}`), signing.privateKey).toString("base64url")}`;
}
let port;
async function request(
  endpoint,
  body,
  token,
  contentType = "application/json",
) {
  const response = await fetch(
    `http://127.0.0.1:${port}/internal/skill-temporary/${endpoint}`,
    {
      method: "POST",
      headers: {
        ...serviceAuthorization,
        "Content-Type": contentType,
        Authorization: token,
      },
      body,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
    },
  );
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { message: raw.slice(0, 256) };
  }
  assert(
    validateWire(data),
    JSON.stringify({ status: response.status, errors: validateWire.errors }),
  );
  return {
    status: response.status,
    data,
    cache: response.headers.get("cache-control"),
  };
}
async function install(
  executionId,
  runId,
  requestId,
  pkg = archive(),
  signing = key,
  kid = "key-1",
) {
  const metadata = {
    action: "temporary_install",
    request_id: requestId,
    job_id: runId,
    generation: 1,
    content_digest: pkg.content_digest,
    artifact_digest: pkg.artifact_digest,
    package_rules_version: 1,
  };
  const body = multipart(metadata, pkg.bytes);
  return request(
    "install",
    body,
    authorization(
      body,
      executionId,
      "temporary_install",
      requestId,
      runId,
      signing,
      kid,
    ),
    "multipart/form-data; boundary=temporary",
  );
}
async function release(executionId, runId) {
  const requestId = `release_${runId}`;
  const body = Buffer.from(
    JSON.stringify({
      action: "temporary_release",
      request_id: requestId,
      job_id: runId,
      generation: 1,
    }),
  );
  return request(
    "release",
    body,
    authorization(body, executionId, "temporary_release", requestId, runId),
  );
}
async function rpc(executionId, method, params) {
  params = {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...serviceAuthorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "MCP-Method": method,
      ...(params.name ? { "MCP-Name": params.name } : {}),
      "X-Antnest-Expected-Execution-ID": executionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
  });
  const raw = await response.text();
  assert([200, 400].includes(response.status), raw);
  const frames = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  return JSON.parse(frames.length ? frames.at(-1).slice(5) : raw);
}
const call = async (executionId, name, args) =>
  (await rpc(executionId, "tools/call", { name, arguments: args })).result;
async function ready() {
  for (let attempt = 0; attempt < 150; attempt++) {
    controller.signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: serviceAuthorization,
        signal: AbortSignal.timeout(1000),
      });
      const value = await response.json();
      if (value.status === "ready") return value;
    } catch {
      /* bounded startup */
    }
    await delay(100, undefined, { signal: controller.signal });
  }
  throw new Error("Runtime temporary fixture readiness timed out");
}
async function helper(script, readonly = false) {
  return docker([
    "run",
    "--rm",
    "--label",
    `io.antnest.test=${prefix}`,
    "--user",
    "1000",
    "--mount",
    `type=volume,src=${volume},dst=/workspace${readonly ? ",readonly" : ""}`,
    "--entrypoint",
    "python",
    image,
    "-c",
    script,
  ]);
}
let result, failure;
try {
  if (build) {
    // A provided Runtime image already passed the build gates in CI.
    const built = await runCommand({
      command: candidateCommand({
        name: "antnest-runtime",
        tag: image,
        build: [
          "docker",
          "build",
          "-f",
          "runtimes/antnest-runtime/Dockerfile",
          "-t",
          image,
          ".",
        ],
      }),
      output,
      name: `${prefix}-build`,
      env: process.env,
    });
    assert.equal(
      built.exit_code,
      0,
      "Runtime build gates failed; inspect private build evidence",
    );
  }
  await docker([
    "network",
    "create",
    "--label",
    `io.antnest.test=${prefix}`,
    network,
  ]);
  await docker([
    "volume",
    "create",
    "--label",
    `io.antnest.test=${prefix}`,
    volume,
  ]);
  const helperBuild = await runCommand({
    name: prefix + "-readiness-build",
    command: [
      "docker",
      "build",
      "-f",
      "tests/support/runtime-tunnel/Dockerfile",
      "-t",
      helperImage,
      ".",
    ],
    output,
    timeoutMs: 1200000,
  });
  assert.equal(helperBuild.exit_code, 0);
  await installRuntimeReceiver(docker, image, authVolume, authDirectory);
  await docker([
    "run",
    "-d",
    "--name",
    egress,
    "--label",
    `io.antnest.test=${prefix}`,
    "--network",
    network,
    "--mount",
    `type=bind,src=${authDirectory}/egress-tunnel.json,dst=/fixture/keys.json,readonly`,
    helperImage,
    "/fixture/keys.json",
  ]);
  port = await freeLoopbackPort();
  const ip = JSON.parse(await docker(["inspect", egress]))[0].NetworkSettings
    .Networks[network].IPAddress;
  const spec = {
    authentication,
    agent_id: "agent-temporary",
    generation: 1,
    listen: { host: "0.0.0.0", port },
    network: {
      packet_contract_revision: 2,
      egress_endpoint: { ipv4: ip, port: 8092 },
      tunnel_ipv4: "100.64.0.2",
      resolver_ipv4: "100.64.0.1",
    },
    filesystem: { workspace: "/workspace", system_skills: "/skills" },
    skill_maintenance_verifiers: {
      keys: [key, nextKey].map((item, index) => ({
        kid: `key-${index + 1}`,
        algorithm: "Ed25519",
        public_key_base64url: item.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64url"),
      })),
    },
  };
  const start = async () => {
    await docker([
      "run",
      "-d",
      "--name",
      runtime,
      "--label",
      `io.antnest.test=${prefix}`,
      "--network",
      network,
      "--cap-drop",
      "ALL",
      "--device",
      "/dev/net/tun",
      "--dns",
      "100.64.0.1",
      "--dns-option",
      "use-vc",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "-p",
      `127.0.0.1:${port}:${port}`,
      "--mount",
      `type=volume,src=${authVolume},dst=/run/antnest-auth,readonly`,
      "-e",
      `ANTNEST_RUNTIME_SPEC=${JSON.stringify(spec)}`,
      "-e",
      "ANTNEST_SERVICE_AUTH_MODE=token",
      "-e",
      "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true",
      "-e",
      `ANTNEST_SERVICE_AUTH_CALLERS_FILE=${authentication.callers_file}`,
      "-e",
      "OTEL_SDK_DISABLED=true",
      ...[
        "CHOWN",
        "DAC_OVERRIDE",
        "KILL",
        "NET_ADMIN",
        "SETGID",
        "SETPCAP",
        "SETUID",
      ].flatMap((cap) => ["--cap-add", cap]),
      image,
    ]);
    return ready();
  };
  const status = await start(),
    execution = status.execution_id;
  const tools = await rpc(execution, "tools/list", {});
  assert.deepEqual(tools.result.tools.map((item) => item.name).sort(), [
    "bash",
    "edit",
    "read",
    "write",
  ]);
  const hidden = await rpc(execution, "tools/call", {
    name: "antnest_skill_temporary_install",
    arguments: {},
  });
  assert(hidden.error);
  const authBody = Buffer.from(
    JSON.stringify({
      action: "temporary_release",
      request_id: "release_auth",
      job_id: "run_auth",
      generation: 1,
    }),
  );
  for (const token of [
    authorization(authBody, execution, "release", "release_auth", "run_auth"),
    authorization(
      authBody,
      execution,
      "temporary_release",
      "release_auth",
      "run_auth",
      key,
      "key-1",
      "another-agent",
    ),
    authorization(
      Buffer.from("changed"),
      execution,
      "temporary_release",
      "release_auth",
      "run_auth",
    ),
    authorization(
      authBody,
      execution,
      "temporary_release",
      "release_auth",
      "run_auth",
      generateKeyPairSync("ed25519"),
    ),
  ]) {
    const rejected = await request("release", authBody, token);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.data.error.effect_state, "none");
  }
  const first = await install(execution, "run_1", "load_1");
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.effect_state, "settled");
  assert.equal(first.data.runtime_call_stopped, true);
  assert.equal(first.cache, "no-store");
  const path = first.data.temporary_path;
  assert.match(
    path,
    /^\/workspace\/\.antnest\/skill-temporary\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/package$/,
  );
  const reused = await install(
    execution,
    "run_1",
    "load_2",
    archive(),
    nextKey,
    "key-2",
  );
  assert.equal(reused.status, 200, JSON.stringify(reused.data));
  assert.equal(reused.data.temporary_path, path);
  const conflict = await install(
    execution,
    "run_1",
    "load_1",
    archive("different-check"),
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, "request_conflict");
  const read = await call(execution, "read", { path: `${path}/SKILL.md` });
  assert.equal(read.isError, false);
  assert.match(JSON.stringify(read), /A temporary executable check/);
  const bash = await call(execution, "bash", {
    command: "./scripts/check.sh",
    working_dir: path,
    timeout_ms: 4000,
  });
  assert.equal(bash.isError, false);
  assert.match(JSON.stringify(bash), /temporary-check-ok/);
  const owner = JSON.parse(
    await helper(
      `import json,pathlib; p=pathlib.Path(${JSON.stringify(path)}); print(json.dumps({'uid':p.stat().st_uid,'symlink':p.is_symlink(),'mode':(p/'scripts/check.sh').stat().st_mode & 0o777}))`,
      true,
    ),
  );
  assert.deepEqual(owner, { uid: 1000, symlink: false, mode: 0o700 });
  await call(execution, "write", {
    path: ".antnest/skills/personal/SKILL.md",
    content:
      "---\nname: personal\ndescription: Preserved personal skill\n---\nKeep.\n",
  });
  const busy = await install(execution, "run_2", "load_1");
  assert.equal(busy.status, 409);
  assert.equal(busy.data.error.code, "temporary_scope_busy");
  for (const [command, pidFile] of [
    ["sleep 10 & echo $! > /workspace/temp-cwd-bg.pid", "temp-cwd-bg.pid"],
    ["./scripts/background.sh", "temp-script-bg.pid"],
  ]) {
    const background = await call(execution, "bash", {
      command,
      working_dir: path,
      timeout_ms: 4000,
    });
    assert.equal(background.isError, true, JSON.stringify(background));
    assert.equal(
      background.structuredContent.error_code,
      "temporary_background_not_supported",
    );
    assert.equal(background.structuredContent.effect_state, "settled");
    const live = await docker([
      "exec",
      "--user",
      "1000",
      runtime,
      "python",
      "-c",
      `import pathlib; pid=pathlib.Path('/workspace/${pidFile}').read_text().strip(); f=pathlib.Path('/proc')/pid/'stat'; print('live' if f.exists() and f.read_text().split()[2] != 'Z' else 'stopped')`,
    ]);
    assert.equal(live, "stopped");
  }
  const otherClosed = await release(execution, "run_other");
  assert.equal(otherClosed.status, 200);
  assert(
    (await call(execution, "read", { path: `${path}/SKILL.md` })).isError ===
      false,
  );
  const released = await release(execution, "run_1");
  assert.equal(released.status, 200, JSON.stringify(released.data));
  assert.equal((await release(execution, "run_1")).status, 200);
  assert.equal(
    (await call(execution, "read", { path: `${path}/SKILL.md` })).isError,
    true,
  );
  const late = await install(execution, "run_1", "load_3");
  assert.equal(late.status, 409);
  assert.equal(late.data.error.code, "run_closed");
  for (let index = 0; index < 4; index++)
    assert.equal(
      (
        await install(
          execution,
          "run_quota",
          `load_${index}`,
          archive(`temporary-${index}`),
        )
      ).status,
      200,
    );
  const quota = await install(
    execution,
    "run_quota",
    "load_5",
    archive("temporary-five"),
  );
  assert.equal(quota.status, 409);
  assert.equal(quota.data.error.code, "limit_exceeded");
  await release(execution, "run_quota");
  const drift = await install(execution, "run_drift", "load_1");
  assert.equal(drift.status, 200);
  const edit = await call(execution, "write", {
    path: `${drift.data.temporary_path}/unexpected.txt`,
    content: "changed",
  });
  assert.equal(edit.isError, false);
  const driftRetry = await install(execution, "run_drift", "load_2");
  assert.equal(driftRetry.status, 409);
  assert.equal(driftRetry.data.error.code, "request_conflict");
  assert.equal((await release(execution, "run_drift")).status, 200);
  assert.equal(
    (await install(execution, "run_shutdown", "load_1")).status,
    200,
  );
  await docker(["stop", "--time", "30", runtime]);
  assert.equal(
    await helper(
      "from pathlib import Path; print((Path('/workspace/.antnest/skill-temporary/v1')).exists())",
      true,
    ),
    "False",
    "normal shutdown cleans temporary files",
  );
  await docker(["rm", "--volumes", runtime]);
  await helper(
    "from pathlib import Path; p=Path('/workspace/.antnest/skill-temporary/v1/inherited.partial'); p.mkdir(parents=True); (p/'partial.txt').write_text('interrupted installation')",
  );
  const restarted = await start();
  assert.notEqual(restarted.execution_id, execution);
  assert.equal(
    await helper(
      "from pathlib import Path; print((Path('/workspace/.antnest/skill-temporary/v1')).exists())",
      true,
    ),
    "False",
    "startup clears inherited partial trees",
  );
  assert.equal(
    (await install(execution, "run_old_execution", "load_1")).status,
    401,
    "fresh ticket for an old process execution is rejected",
  );
  assert.equal(
    (
      await call(restarted.execution_id, "read", {
        path: ".antnest/skills/personal/SKILL.md",
      })
    ).isError,
    false,
  );
  const current = await install(
    restarted.execution_id,
    "run_new_execution",
    "load_1",
  );
  assert.equal(current.status, 200, JSON.stringify(current.data));
  assert.equal(
    (await release(restarted.execution_id, "run_new_execution")).status,
    200,
  );
  result = {
    status: "runtime_temporary_files_passed",
    project: prefix,
    image,
    real_files: true,
    uid: 1000,
    current_and_next_keys: true,
    foreground_execution: true,
    background_via_cwd_and_script_stopped: true,
    quota: true,
    run_release_fence: true,
    normal_shutdown_cleanup: true,
    inherited_restart_cleanup: true,
    old_execution_rejected: true,
    personal_skill_preserved: true,
  };
} catch (error) {
  failure = error;
} finally {
  const clean = dockerClient(process.env, undefined, 240000);
  const errors = [];
  for (const name of [runtime, egress]) {
    try {
      const found = await clean(["ps", "-aq", "--filter", `name=^${name}$`]);
      if (found && failure)
        await runCommand({
          command: ["docker", "logs", "--tail", "200", name],
          output,
          name: `${name}-logs`,
          env: process.env,
        });
      if (found) await clean(["rm", "-f", "--volumes", name]);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const [kind, name] of [
    ["volume", volume],
    ["volume", authVolume],
    ["network", network],
  ]) {
    try {
      const found = await clean([
        kind,
        "ls",
        "-q",
        "--filter",
        `name=^${name}$`,
      ]);
      if (found) await clean([kind, "rm", name]);
    } catch (error) {
      errors.push(error);
    }
  }
  await clean(["image", "rm", helperImage]).catch((error) =>
    errors.push(error),
  );
  if (build) {
    try {
      const found = await clean(["image", "ls", "-q", image]);
      if (found) await clean(["image", "rm", image]);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    for (const kind of ["container", "volume", "network"])
      assert.equal(
        await clean([
          kind,
          "ls",
          kind === "container" ? "-aq" : "-q",
          "--filter",
          `label=io.antnest.test=${prefix}`,
        ]),
        "",
      );
  } catch (error) {
    errors.push(error);
  }
  rmSync(authDirectory, { recursive: true, force: true });
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  writeFileSync(
    `${output}/${prefix}-result.json`,
    JSON.stringify(
      { ...(result ?? { status: "failed" }), cleanup: errors.length === 0 },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Runtime temporary verification or cleanup failed",
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
