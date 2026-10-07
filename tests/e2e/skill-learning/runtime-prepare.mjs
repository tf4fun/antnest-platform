import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeReceiver,
  freeLoopbackPort,
  installRuntimeReceiver,
} from "../../support/runtime-receiver-fixture.mjs";

const image =
  process.env.ANTNEST_RUNTIME_TEST_IMAGE ??
  "antnest/antnest-runtime:skill-learning-local";
const buildImage =
  process.env.ANTNEST_RUNTIME_BUILD_IMAGE ??
  "antnest/antnest-runtime:skill-learning-build";
const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../antnest-runtime/fixtures/egress_probe.py",
);
const prefix = `antnest-skill-prepare-${process.pid}`;
const network = `${prefix}-network`;
const egress = `${prefix}-egress`;
const runtime = `${prefix}-runtime`;
const fixtureSource = `${prefix}-fixture-source`;
const volume = `${prefix}-workspace`;
const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
chmodSync(directory, 0o755);
const authVolume = `${prefix}-receiver`;
const authDirectory = join(directory, "auth");
const authentication = createRuntimeReceiver(authDirectory);
// The ACP credential is admitted on every Runtime route this runner uses.
const serviceToken = readFileSync(join(authDirectory, "mcp.headers"), "utf8")
  .trim()
  .replace(/^Antnest-Service-Authorization: /, "");
function runtimeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { "Antnest-Service-Authorization": serviceToken, ...init.headers },
  });
}

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function cleanup() {
  for (const name of [runtime, egress, fixtureSource]) {
    try {
      docker("rm", "-f", "--volumes", name);
    } catch {
      /* absent */
    }
  }
  try {
    docker("volume", "rm", volume, authVolume);
  } catch {
    /* absent */
  }
  try {
    docker("network", "rm", network);
  } catch {
    /* absent */
  }
  rmSync(directory, { recursive: true, force: true });
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}
function label(bytes) {
  return `sha256:${sha256(bytes).toString("hex")}`;
}
function targetDigest(path, contents) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(contents.length));
  const pathSize = Buffer.alloc(4);
  pathSize.writeUInt32BE(Buffer.byteLength(path));
  return label(
    Buffer.concat([
      Buffer.from("antnest-skill-manifest-v1\0"),
      pathSize,
      Buffer.from(path),
      size,
      sha256(contents),
      Buffer.from([0]),
    ]),
  );
}
function makeZip(contents) {
  const source = join(directory, "package");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), contents);
  const archive = join(directory, "skill.zip");
  execFileSync("python3", [
    "-c",
    `
import sys, zipfile
item = zipfile.ZipInfo('SKILL.md')
item.create_system = 3
item.external_attr = 0o100644 << 16
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_STORED) as z:
    z.writestr(item, open(sys.argv[2], 'rb').read())
`,
    archive,
    join(source, "SKILL.md"),
  ]);
  return readFileSync(archive);
}
function signed(
  privateKey,
  body,
  executionId,
  action,
  requestId,
  jobId = "job-1",
  generation = 1,
  kid = "key-1",
) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ version: 1, algorithm: "Ed25519", kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      organization_id: "org-1",
      agent_id: "agent-1",
      execution_id: executionId,
      job_id: jobId,
      generation,
      action,
      request_id: requestId,
      body_sha256: label(body),
      issued_at: now,
      expires_at: now + 60,
    }),
  ).toString("base64url");
  const message = Buffer.from(
    `antnest-skill-maintenance-v1\n${header}.${payload}`,
  );
  const signature = sign(null, message, privateKey).toString("base64url");
  return `AntnestMaintenance ${header}.${payload}.${signature}`;
}
function multipart(metadata, artifact) {
  return Buffer.concat([
    Buffer.from(
      '--skill-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n',
    ),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(
      '\r\n--skill-boundary\r\nContent-Disposition: form-data; name="artifact"\r\n\r\n',
    ),
    artifact,
    Buffer.from("\r\n--skill-boundary--\r\n"),
  ]);
}
async function ready(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await runtimeFetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) {
        const status = await response.json();
        if (status.status === "ready") return status;
      }
    } catch {
      /* startup */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Runtime did not become ready: ${docker("logs", runtime)}`);
}

async function callTool(port, executionId, name, args) {
  const params = {
    name,
    arguments: args,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  const response = await runtimeFetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "MCP-Method": "tools/call",
      "MCP-Name": name,
      "X-Antnest-Expected-Execution-ID": executionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params,
    }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const events = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  const envelope = JSON.parse(events.length ? events.at(-1).slice(5) : raw);
  assert.equal(envelope.error, undefined, raw);
  return envelope.result;
}

function bash(port, executionId, command) {
  return callTool(port, executionId, "bash", {
    command,
    working_dir: ".",
    env: [],
    timeout_ms: 3000,
  });
}

try {
  const [releaseImage] = JSON.parse(docker("image", "inspect", image));
  assert.equal(
    releaseImage.Config.Labels["dev.antnest.runtime.test-features"],
    "",
  );
  assert(
    !releaseImage.Config.Env.some((value) =>
      value.startsWith("ANTNEST_RUNTIME_ALLOW_TEST_FEATURES="),
    ),
    "release images must not opt in to test features",
  );
  docker("create", "--name", fixtureSource, buildImage, "/bin/true");
  const managedFixture = join(directory, "managed-mcp-fixture");
  docker("cp", `${fixtureSource}:/tmp/managed-mcp-fixture`, managedFixture);
  chmodSync(managedFixture, 0o755);
  docker("rm", "-f", "--volumes", fixtureSource);
  docker("network", "create", network);
  docker("volume", "create", volume);
  await installRuntimeReceiver(
    (args) => docker(...args),
    image,
    authVolume,
    authDirectory,
  );
  docker(
    "run",
    "-d",
    "--name",
    egress,
    "--network",
    network,
    "--mount",
    `type=bind,src=${fixture},dst=/probe.py,readonly`,
    "--entrypoint",
    "python",
    image,
    "/probe.py",
  );
  const egressIp = JSON.parse(docker("inspect", egress))[0].NetworkSettings
    .Networks[network].IPAddress;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { publicKey: nextPublicKey, privateKey: nextPrivateKey } =
    generateKeyPairSync("ed25519");
  const publicBytes = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const nextPublicBytes = nextPublicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const listenPort = await freeLoopbackPort();
  const spec = {
    authentication,
    agent_id: "agent-1",
    generation: 1,
    listen: { host: "0.0.0.0", port: listenPort },
    network: {
      packet_contract_revision: 1,
      egress_endpoint: { ipv4: egressIp, port: 8092 },
      tunnel_ipv4: "100.64.0.2",
      resolver_ipv4: "100.64.0.1",
    },
    filesystem: { workspace: "/workspace", system_skills: "/skills" },
    mcp_servers: [{ id: "learning", command: "/opt/managed-mcp-fixture" }],
    skill_maintenance_verifiers: {
      keys: [
        {
          kid: "key-1",
          algorithm: "Ed25519",
          public_key_base64url: publicBytes.toString("base64url"),
        },
        {
          kid: "key-2",
          algorithm: "Ed25519",
          public_key_base64url: nextPublicBytes.toString("base64url"),
        },
      ],
    },
  };
  const startRuntime = (runtimeSpec) => {
    docker(
      "run",
      "-d",
      "--name",
      runtime,
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
      "--mount",
      `type=bind,src=${managedFixture},dst=/opt/managed-mcp-fixture,readonly`,
      // Mirrors the private managed MCP HOME tmpfs Runtime Controller creates.
      "--tmpfs",
      "/run/antnest-mcp-home:rw,exec,nosuid,nodev,size=67108864,mode=0711,uid=0,gid=0",
      "-p",
      `127.0.0.1:${listenPort}:${listenPort}`,
      "--mount",
      `type=volume,src=${authVolume},dst=/run/antnest-auth,readonly`,
      "-e",
      `ANTNEST_RUNTIME_SPEC=${JSON.stringify(runtimeSpec)}`,
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
      ].flatMap((capability) => ["--cap-add", capability]),
      image,
    );
    return JSON.parse(docker("inspect", runtime))[0].NetworkSettings.Ports[
      `${listenPort}/tcp`
    ][0].HostPort;
  };
  let port = startRuntime(spec);
  const status = await ready(port);
  assert.deepEqual(status.test_features, []);
  const removedRevert = await runtimeFetch(
    `http://127.0.0.1:${port}/internal/skill-maintenance/revert`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(removedRevert.status, 404);
  const atomicFlags = `
import ctypes, os, pathlib, shutil
root = pathlib.Path('/workspace/.antnest/skill-learning/atomic-volume-probe')
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True)
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
def rename(source, target, flag):
    result = renameat2(-100, os.fsencode(source), -100, os.fsencode(target), flag)
    if result != 0:
        raise OSError(ctypes.get_errno(), 'renameat2 failed')
try:
    first, second = root / 'first', root / 'second'
    first.mkdir(); (first / 'version').write_text('first')
    rename(first, second, 1)
    assert not first.exists() and (second / 'version').read_text() == 'first'
    first.mkdir(); (first / 'version').write_text('second')
    try:
        rename(first, second, 1)
        raise AssertionError('RENAME_NOREPLACE overwrote an existing directory')
    except FileExistsError:
        pass
    rename(first, second, 2)
    assert (first / 'version').read_text() == 'first'
    assert (second / 'version').read_text() == 'second'
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
finally:
    shutil.rmtree(root)
`;
  docker("exec", "--user", "1000:1000", runtime, "python3", "-c", atomicFlags);
  const contents = Buffer.from(
    "---\nname: retry-timeouts\ndescription: Retry safely\n---\n",
  );
  const artifact = makeZip(contents);
  const metadata = {
    action: "prepare",
    request_id: "request-1",
    job_id: "job-1",
    generation: 1,
    candidate_id: "candidate-1",
    package_path: ".antnest/skills/retry-timeouts",
    expected_base_digest: null,
    target_digest: targetDigest("SKILL.md", contents),
    artifact_digest: label(artifact),
    package_rules_version: 1,
  };
  const body = multipart(metadata, artifact);
  const send = (preparedBody = body, signingKey = privateKey, kid = "key-1") =>
    runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/prepare`,
      {
        method: "POST",
        headers: {
          Authorization: signed(
            signingKey,
            preparedBody,
            status.execution_id,
            "prepare",
            "request-1",
            "job-1",
            1,
            kid,
          ),
          "Content-Type": "multipart/form-data; boundary=skill-boundary",
          "X-Antnest-Expected-Execution-ID": status.execution_id,
        },
        body: preparedBody,
      },
    );
  const checkBody = Buffer.from(
    JSON.stringify({
      action: "check",
      request_id: "check-1",
      job_id: "job-1",
      generation: 1,
      candidate_id: "candidate-1",
      package_path: metadata.package_path,
      target_digest: metadata.target_digest,
      package_rules_version: 1,
    }),
  );
  const check = () =>
    runtimeFetch(`http://127.0.0.1:${port}/internal/skill-maintenance/check`, {
      method: "POST",
      headers: {
        Authorization: signed(
          privateKey,
          checkBody,
          status.execution_id,
          "check",
          "check-1",
        ),
        "Content-Type": "application/json",
        "X-Antnest-Expected-Execution-ID": status.execution_id,
      },
      body: checkBody,
    });
  let preparedStorageKey;
  const unknownKid = await send(body, nextPrivateKey, "unknown-key");
  assert.equal(unknownKid.status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response =
      attempt === 0 ? await send(body, nextPrivateKey, "key-2") : await send();
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.outcome, "prepared");
    assert.equal(result.observed_digest, metadata.target_digest);
    assert.match(result.storage_key, /^[0-9a-f]{64}$/);
    preparedStorageKey = result.storage_key;
  }
  const changedBase = await send(
    multipart(
      {
        ...metadata,
        expected_base_digest: label(Buffer.from("different base")),
      },
      artifact,
    ),
  );
  assert.equal(changedBase.status, 409);
  assert.equal((await changedBase.json()).error.code, "request_conflict");
  const checked = await check();
  assert.equal(
    checked.status,
    200,
    JSON.stringify(await checked.clone().json()),
  );
  assert.equal((await checked.json()).outcome, "checked");
  const entries = docker(
    "exec",
    runtime,
    "ls",
    "-1",
    "/workspace/.antnest/skill-learning/candidates",
  )
    .split("\n")
    .filter(Boolean);
  assert.equal(entries.length, 1);
  const stored = `/workspace/.antnest/skill-learning/candidates/${entries[0]}/package/SKILL.md`;
  assert.equal(
    docker("exec", runtime, "cat", stored),
    contents.toString().trim(),
  );
  assert.equal(
    docker("exec", runtime, "stat", "-c", "%u:%g", stored),
    "1000:1000",
  );
  docker(
    "exec",
    runtime,
    "touch",
    `/workspace/.antnest/skill-learning/candidates/${entries[0]}/package/unexpected.txt`,
  );
  const drifted = await send();
  assert.equal(drifted.status, 409);
  assert.equal((await drifted.json()).error.code, "request_conflict");
  const checkDrifted = await check();
  assert.equal(checkDrifted.status, 409);
  docker(
    "exec",
    runtime,
    "rm",
    `/workspace/.antnest/skill-learning/candidates/${entries[0]}/package/unexpected.txt`,
  );
  const rechecked = await check();
  assert.equal(rechecked.status, 200);
  const commitBody = Buffer.from(
    JSON.stringify({
      action: "commit",
      request_id: "commit-1",
      job_id: "job-1",
      generation: 1,
      candidate_id: "candidate-1",
      package_path: metadata.package_path,
      expected_base_digest: null,
      target_digest: metadata.target_digest,
    }),
  );
  const commit = () =>
    runtimeFetch(`http://127.0.0.1:${port}/internal/skill-maintenance/commit`, {
      method: "POST",
      headers: {
        Authorization: signed(
          privateKey,
          commitBody,
          status.execution_id,
          "commit",
          "commit-1",
        ),
        "Content-Type": "application/json",
        "X-Antnest-Expected-Execution-ID": status.execution_id,
      },
      body: commitBody,
    });
  const started = await bash(
    port,
    status.execution_id,
    "sleep 60 >/dev/null 2>&1 </dev/null & echo $! > skill-background.pid",
  );
  assert.equal(started.structuredContent.exit_code, 0);
  const blocked = await commit();
  assert.equal(blocked.status, 200);
  const blockedResult = await blocked.json();
  assert.equal(blockedResult.outcome, "blocked");
  assert.equal(blockedResult.blocked_reason, "background_task_running");
  assert.match(blockedResult.blocked_subject_id, /^bash:[0-9]+$/);
  const stopped = await bash(
    port,
    status.execution_id,
    "kill $(cat skill-background.pid)",
  );
  assert.equal(stopped.structuredContent.exit_code, 0);
  const spawned = await callTool(
    port,
    status.execution_id,
    "mcp__learning__spawn_worker",
    {},
  );
  const managedPid = spawned.structuredContent.pid;
  assert.equal(Number.isSafeInteger(managedPid), true);
  const managedBlocked = await commit();
  assert.equal(managedBlocked.status, 200);
  const managedBlockedResult = await managedBlocked.json();
  assert.equal(managedBlockedResult.outcome, "blocked");
  assert.equal(managedBlockedResult.blocked_reason, "managed_call_in_flight");
  assert.equal(managedBlockedResult.blocked_subject_id, "managed:learning");
  // Managed MCP servers run under their own UID, so the workspace user cannot
  // signal the worker; only the in-flight state is under test here.
  docker("exec", "--user", "0", runtime, "sh", "-c", `kill ${managedPid}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    for (let wait = 0; wait < 20; wait++) {
      response = await commit();
      if ((await response.clone().json()).outcome !== "blocked") break;
      await new Promise((done) => setTimeout(done, 100));
    }
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.outcome, "applied");
    assert.equal(result.observed_digest, metadata.target_digest);
    assert.equal(
      docker(
        "exec",
        runtime,
        "cat",
        "/workspace/.antnest/skills/retry-timeouts/SKILL.md",
      ),
      contents.toString().trim(),
    );
  }
  const observe = async (
    executionId,
    effectRequestId,
    requestId,
    targetDigest = metadata.target_digest,
  ) => {
    const observeBody = Buffer.from(
      JSON.stringify({
        action: "observe",
        request_id: requestId,
        job_id: "job-1",
        generation: 1,
        effect_request_id: effectRequestId,
        expected_target_digest: targetDigest,
      }),
    );
    return runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/observe`,
      {
        method: "POST",
        headers: {
          Authorization: signed(
            privateKey,
            observeBody,
            executionId,
            "observe",
            requestId,
          ),
          "Content-Type": "application/json",
          "X-Antnest-Expected-Execution-ID": executionId,
        },
        body: observeBody,
      },
    );
  };
  const observed = await observe(status.execution_id, "commit-1", "observe-1");
  assert.equal(observed.status, 200);
  assert.equal((await observed.json()).outcome, "applied");
  docker("restart", runtime);
  port = JSON.parse(docker("inspect", runtime))[0].NetworkSettings.Ports[
    `${listenPort}/tcp`
  ][0].HostPort;
  const restarted = await ready(port);
  assert.notEqual(restarted.execution_id, status.execution_id);
  const recovered = await observe(
    restarted.execution_id,
    "commit-1",
    "observe-2",
  );
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).outcome, "applied");
  const absent = await observe(
    restarted.execution_id,
    "missing-effect",
    "observe-3",
  );
  assert.equal(absent.status, 200);
  assert.equal((await absent.json()).outcome, "unknown");
  docker(
    "exec",
    runtime,
    "touch",
    "/workspace/.antnest/skills/retry-timeouts/unexpected.txt",
  );
  const changed = await observe(
    restarted.execution_id,
    "commit-1",
    "observe-4",
  );
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).outcome, "conflict");
  const cancelBody = Buffer.from(
    JSON.stringify({
      action: "cancel",
      request_id: "cancel-2",
      job_id: "job-2",
      generation: 2,
    }),
  );
  const maintenancePost = (action, body, requestId, executionId) =>
    runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/${action}`,
      {
        method: "POST",
        headers: {
          Authorization: signed(
            privateKey,
            body,
            executionId,
            action,
            requestId,
            "job-2",
            2,
          ),
          "Content-Type": "application/json",
          "X-Antnest-Expected-Execution-ID": executionId,
        },
        body,
      },
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await maintenancePost(
      "cancel",
      cancelBody,
      "cancel-2",
      restarted.execution_id,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).outcome, "cancelled");
  }
  const forbiddenCommitBody = Buffer.from(
    JSON.stringify({
      action: "commit",
      request_id: "commit-after-cancel",
      job_id: "job-2",
      generation: 2,
      candidate_id: "candidate-2",
      package_path: metadata.package_path,
      expected_base_digest: null,
      target_digest: metadata.target_digest,
    }),
  );
  const denied = await maintenancePost(
    "commit",
    forbiddenCommitBody,
    "commit-after-cancel",
    restarted.execution_id,
  );
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, "generation_cancelled");
  docker("restart", runtime);
  port = JSON.parse(docker("inspect", runtime))[0].NetworkSettings.Ports[
    `${listenPort}/tcp`
  ][0].HostPort;
  const restartedAgain = await ready(port);
  const deniedAfterRestart = await maintenancePost(
    "commit",
    forbiddenCommitBody,
    "commit-after-cancel",
    restartedAgain.execution_id,
  );
  assert.equal(deniedAfterRestart.status, 409);
  assert.equal(
    (await deniedAfterRestart.json()).error.code,
    "generation_cancelled",
  );
  docker(
    "exec",
    runtime,
    "rm",
    "/workspace/.antnest/skills/retry-timeouts/unexpected.txt",
  );
  const release = async (
    storageClass,
    storageKey,
    expectedDigest,
    requestId,
    jobId = "job-1",
    generation = 1,
  ) => {
    const releaseBody = Buffer.from(
      JSON.stringify({
        action: "release",
        request_id: requestId,
        job_id: jobId,
        generation,
        storage_class: storageClass,
        storage_key: storageKey,
        package_path: metadata.package_path,
        expected_digest: expectedDigest,
      }),
    );
    return runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/release`,
      {
        method: "POST",
        headers: {
          Authorization: signed(
            privateKey,
            releaseBody,
            restartedAgain.execution_id,
            "release",
            requestId,
            jobId,
            generation,
          ),
          "Content-Type": "application/json",
          "X-Antnest-Expected-Execution-ID": restartedAgain.execution_id,
        },
        body: releaseBody,
      },
    );
  };
  const mismatchedRelease = await release(
    "candidate",
    preparedStorageKey,
    `sha256:${"0".repeat(64)}`,
    "release-mismatch",
  );
  assert.equal(
    mismatchedRelease.status,
    409,
    await mismatchedRelease.clone().text(),
  );
  assert.equal((await mismatchedRelease.json()).error.code, "request_conflict");
  const missingRelease = await release(
    "candidate",
    "0".repeat(64),
    metadata.target_digest,
    "release-missing",
  );
  assert.equal(missingRelease.status, 503, await missingRelease.clone().text());
  assert.equal((await missingRelease.json()).error.code, "outcome_unknown");
  for (const [
    storageClass,
    storageKey,
    expectedDigest,
    requestId,
    jobId,
    generation,
  ] of [
    [
      "candidate",
      preparedStorageKey,
      metadata.target_digest,
      "release-candidate",
      "job-1",
      1,
    ],
  ]) {
    const first = await release(
      storageClass,
      storageKey,
      expectedDigest,
      requestId,
      jobId,
      generation,
    );
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal((await first.json()).outcome, "released");
    const again = await release(
      storageClass,
      storageKey,
      expectedDigest,
      requestId,
      jobId,
      generation,
    );
    assert.equal(again.status, 200, await again.clone().text());
    assert.equal((await again.json()).outcome, "released");
    assert.equal(
      docker(
        "exec",
        runtime,
        "test",
        "!",
        "-e",
        `/workspace/.antnest/skill-learning/${storageClass === "candidate" ? "candidates" : storageClass}/${storageKey}`,
      ),
      "",
    );
  }
  const releasedCandidatePath = `/workspace/.antnest/skill-learning/candidates/${preparedStorageKey}`;
  docker(
    "exec",
    "--user",
    "1000:1000",
    runtime,
    "mkdir",
    releasedCandidatePath,
  );
  const replayAfterRecreate = await release(
    "candidate",
    preparedStorageKey,
    metadata.target_digest,
    "release-candidate",
  );
  assert.equal(replayAfterRecreate.status, 200);
  assert.equal((await replayAfterRecreate.json()).outcome, "released");
  assert.equal(
    docker("exec", runtime, "test", "-d", releasedCandidatePath),
    "",
  );
  docker(
    "exec",
    "--user",
    "1000:1000",
    runtime,
    "python3",
    "-c",
    "import pathlib; p=pathlib.Path('/workspace/.antnest/skill-learning/candidates/fill/SKILL.md'); p.parent.mkdir(parents=True); p.open('wb').truncate(268435456)",
  );
  const fullMetadata = {
    ...metadata,
    request_id: "request-capacity",
    job_id: "job-capacity",
    generation: 3,
    candidate_id: "candidate-capacity",
  };
  const fullBody = multipart(fullMetadata, artifact);
  const prepareAfterFill = () =>
    runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/prepare`,
      {
        method: "POST",
        headers: {
          Authorization: signed(
            privateKey,
            fullBody,
            restartedAgain.execution_id,
            "prepare",
            fullMetadata.request_id,
            fullMetadata.job_id,
            fullMetadata.generation,
          ),
          "Content-Type": "multipart/form-data; boundary=skill-boundary",
          "X-Antnest-Expected-Execution-ID": restartedAgain.execution_id,
        },
        body: fullBody,
      },
    );
  const full = await prepareAfterFill();
  assert.equal(full.status, 409, await full.clone().text());
  assert.equal((await full.json()).error.code, "skill_storage_full");
  docker(
    "exec",
    "--user",
    "1000:1000",
    runtime,
    "rm",
    "-r",
    "/workspace/.antnest/skill-learning/candidates/fill",
  );
  const recoveredCapacity = await prepareAfterFill();
  assert.equal(
    recoveredCapacity.status,
    200,
    await recoveredCapacity.clone().text(),
  );
  assert.equal((await recoveredCapacity.json()).outcome, "prepared");
  docker("rm", "-f", "--volumes", runtime);
  port = startRuntime({
    ...spec,
    skill_maintenance_verifiers: {
      keys: [spec.skill_maintenance_verifiers.keys[1]],
    },
  });
  const reducedTrust = await ready(port);
  assert.notEqual(reducedTrust.execution_id, status.execution_id);
  const rotatedMetadata = {
    ...metadata,
    request_id: "request-after-old-key-removal",
    job_id: "job-after-old-key-removal",
    candidate_id: "candidate-after-old-key-removal",
  };
  const rotatedBody = multipart(rotatedMetadata, artifact);
  const afterRemoval = (signingKey, kid) =>
    runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/prepare`,
      {
        method: "POST",
        headers: {
          Authorization: signed(
            signingKey,
            rotatedBody,
            reducedTrust.execution_id,
            "prepare",
            rotatedMetadata.request_id,
            rotatedMetadata.job_id,
            1,
            kid,
          ),
          "Content-Type": "multipart/form-data; boundary=skill-boundary",
          "X-Antnest-Expected-Execution-ID": reducedTrust.execution_id,
        },
        body: rotatedBody,
      },
    );
  const removedKey = await afterRemoval(privateKey, "key-1");
  assert.equal(removedKey.status, 401, await removedKey.clone().text());
  const retainedKey = await afterRemoval(nextPrivateKey, "key-2");
  assert.equal(retainedKey.status, 200, await retainedKey.clone().text());
  assert.equal((await retainedKey.json()).outcome, "prepared");
  console.log(
    "Skill dual-key trust/unknown-kid rejection/old-key removal and prepare/check/commit/observe/cancel/release/capacity HTTP → UID 1000 executor → Bash/managed blocking/retry/restart: passed",
  );
} finally {
  cleanup();
}
