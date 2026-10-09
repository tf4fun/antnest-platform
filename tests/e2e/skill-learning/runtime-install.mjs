// Docker E2E for the private Skill learning `install` and `digest` actions:
// HTTP ticket → Execution Actor → UID 1000 executor → one atomic rename, with
// writer blocking, foreground preemption, resend and startup staging cleanup.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeReceiver,
  freeLoopbackPort,
  installRuntimeReceiver,
} from "../../support/runtime-receiver-fixture.mjs";

// The gate image adds only the after-rename hold used to preempt an install
// whose rename already happened; every other path is the release code.
const image =
  process.env.ANTNEST_RUNTIME_GATE_IMAGE ??
  "antnest/antnest-runtime:skill-learning-gate";
const buildImage =
  process.env.ANTNEST_RUNTIME_BUILD_IMAGE ??
  "antnest/antnest-runtime:skill-learning-build";
const requireFromAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireFromAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/skill-learning/learning-api.schema.json",
      import.meta.url,
    ),
  ),
);
const ajv = new Ajv2020({ strict: true, validateFormats: false });
ajv.addSchema(schema);
function conforms(name, value) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert(validate, `missing ${name} definition`);
  assert(
    validate(value),
    `${name} ${JSON.stringify(value)}: ${ajv.errorsText(validate.errors)}`,
  );
}
const prefix = `antnest-skill-install-${process.pid}`;
const network = `${prefix}-network`;
const egress = `${prefix}-egress`;
const runtime = `${prefix}-runtime`;
const fixtureSource = `${prefix}-fixture-source`;
const volume = `${prefix}-workspace`;
const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
chmodSync(directory, 0o755);
const authVolume = `${prefix}-receiver`;
const helperImage = `${prefix}:readiness`;
const authDirectory = join(directory, "auth");
const authentication = createRuntimeReceiver(authDirectory);
const serviceToken = readFileSync(join(authDirectory, "mcp.headers"), "utf8")
  .trim()
  .replace(/^Antnest-Service-Authorization: /, "");
const skillPath = ".antnest/skills/retry-timeouts";
const activeRoot = `/workspace/${skillPath}`;
const staging = "/workspace/.antnest/skill-learning/staging";
const gate = "/workspace/.antnest/skill-learning/e2e-install-gate";

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
function exists(path) {
  try {
    docker("exec", runtime, "test", "-e", path);
    return true;
  } catch {
    return false;
  }
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
  try {
    docker("image", "rm", helperImage);
  } catch {
    /* helper was not built */
  }
  rmSync(directory, { recursive: true, force: true });
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}
function label(bytes) {
  return `sha256:${sha256(bytes).toString("hex")}`;
}
function targetDigest(contents) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(contents.length));
  const pathSize = Buffer.alloc(4);
  pathSize.writeUInt32BE(Buffer.byteLength("SKILL.md"));
  return label(
    Buffer.concat([
      Buffer.from("antnest-skill-manifest-v1\0"),
      pathSize,
      Buffer.from("SKILL.md"),
      size,
      sha256(contents),
      Buffer.from([0]),
    ]),
  );
}
let zipCount = 0;
function version(description) {
  const contents = Buffer.from(
    `---\nname: retry-timeouts\ndescription: ${description}\n---\n`,
  );
  const source = join(directory, `package-${zipCount}`);
  const archive = join(directory, `skill-${zipCount++}.zip`);
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), contents);
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
  const artifact = readFileSync(archive);
  return { contents, artifact, digest: targetDigest(contents) };
}
function ticket(privateKey, body, executionId, action, requestId) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ version: 1, algorithm: "Ed25519", kid: "key-1" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      organization_id: "org-1",
      agent_id: "agent-1",
      execution_id: executionId,
      job_id: "job-1",
      generation: 1,
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
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const events = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  const envelope = JSON.parse(events.length ? events.at(-1).slice(5) : raw);
  assert.equal(envelope.error, undefined, raw);
  return envelope.result;
}
function bash(port, executionId, command, timeout = 3000) {
  return callTool(port, executionId, "bash", {
    command,
    working_dir: ".",
    env: [],
    timeout_ms: timeout,
  });
}
async function waitFor(predicate, what) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  const [gateImage] = JSON.parse(docker("image", "inspect", image));
  assert.equal(
    gateImage.Config.Labels["dev.antnest.runtime.test-features"],
    "skill-maintenance-e2e-gate",
  );
  docker("create", "--name", fixtureSource, buildImage, "/bin/true");
  const managedFixture = join(directory, "managed-mcp-fixture");
  docker("cp", `${fixtureSource}:/tmp/managed-mcp-fixture`, managedFixture);
  chmodSync(managedFixture, 0o755);
  docker("rm", "-f", "--volumes", fixtureSource);
  docker("network", "create", network);
  docker("volume", "create", volume);
  docker(
    "build",
    "-f",
    "tests/support/runtime-tunnel/Dockerfile",
    "-t",
    helperImage,
    ".",
  );
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
    `type=bind,src=${authDirectory}/egress-tunnel.json,dst=/fixture/keys.json,readonly`,
    helperImage,
    "/fixture/keys.json",
  );
  const egressIp = JSON.parse(docker("inspect", egress))[0].NetworkSettings
    .Networks[network].IPAddress;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const listenPort = await freeLoopbackPort();
  const spec = {
    authentication,
    agent_id: "agent-1",
    generation: 1,
    listen: { host: "0.0.0.0", port: listenPort },
    network: {
      packet_contract_revision: 2,
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
          public_key_base64url: publicKey
            .export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("base64url"),
        },
      ],
    },
  };
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
    "--tmpfs",
    "/run/antnest-mcp-home:rw,exec,nosuid,nodev,size=67108864,mode=0711,uid=0,gid=0",
    "-p",
    `127.0.0.1:${listenPort}:${listenPort}`,
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
    ].flatMap((capability) => ["--cap-add", capability]),
    image,
  );
  const portOf = () =>
    JSON.parse(docker("inspect", runtime))[0].NetworkSettings.Ports[
      `${listenPort}/tcp`
    ][0].HostPort;
  let port = portOf();
  let status = await ready(port);
  assert.deepEqual(status.test_features, ["skill-maintenance-e2e-gate"]);

  let sequence = 0;
  const maintenance = async (fields, artifact) => {
    const { action } = fields;
    const requestId = `${action}-${++sequence}`;
    const request = {
      action,
      request_id: requestId,
      job_id: "job-1",
      generation: 1,
      package_path: skillPath,
      ...fields,
    };
    conforms(`${action}_request`, request);
    const signedBody = artifact
      ? multipart(request, artifact)
      : Buffer.from(JSON.stringify(request));
    const response = await runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/${action}`,
      {
        method: "POST",
        headers: {
          Authorization: ticket(
            privateKey,
            signedBody,
            status.execution_id,
            action,
            requestId,
          ),
          "Content-Type": artifact
            ? "multipart/form-data; boundary=skill-boundary"
            : "application/json",
          "X-Antnest-Expected-Execution-ID": status.execution_id,
        },
        body: signedBody,
      },
    );
    const receipt = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receipt));
    conforms("maintenance_receipt", receipt);
    assert.equal(receipt.request_id, requestId);
    assert.equal(receipt.action, action);
    assert.equal(receipt.execution_id, status.execution_id);
    return receipt;
  };
  const install = (target, base) =>
    maintenance(
      {
        action: "install",
        expected_base_digest: base,
        target_digest: target.digest,
        artifact_digest: label(target.artifact),
        package_rules_version: 1,
      },
      target.artifact,
    );
  const digest = () => maintenance({ action: "digest" });
  const inode = () => docker("exec", runtime, "stat", "-c", "%i", activeRoot);
  const activeText = () =>
    docker("exec", runtime, "cat", `${activeRoot}/SKILL.md`);
  const keys = (receipt) => Object.keys(receipt).sort();

  const first = version("Retry safely");
  const second = version("Retry safely with backoff");
  const third = version("Retry safely with backoff and jitter");
  const foreign = version("Written by someone else");

  // Digest of an absent package is observed as null.
  const absent = await digest();
  assert.equal(absent.outcome, "observed");
  assert.equal(absent.observed_digest, null);

  // A staging tree left by an interrupted install is removed first.
  docker(
    "exec",
    "--user",
    "1000:1000",
    runtime,
    "sh",
    "-c",
    `mkdir -p ${staging}/install/package && echo interrupted > ${staging}/install/package/SKILL.md`,
  );
  const created = await install(first, null);
  assert.deepEqual(keys(created), [
    "action",
    "execution_id",
    "observed_digest",
    "outcome",
    "request_id",
  ]);
  assert.equal(created.outcome, "applied");
  assert.equal(created.observed_digest, first.digest);
  assert.equal(activeText(), first.contents.toString().trim());
  assert.equal(
    docker("exec", runtime, "stat", "-c", "%u:%g", `${activeRoot}/SKILL.md`),
    "1000:1000",
  );
  assert.equal(exists(staging), false, "install must remove its staging tree");
  const createdInode = inode();

  // A resend with a fresh ticket settles from the active bytes.
  const resent = await install(first, null);
  assert.equal(resent.outcome, "applied");
  assert.equal(resent.observed_digest, first.digest);
  assert.equal(inode(), createdInode, "a resend must not rename again");
  assert.equal((await digest()).observed_digest, first.digest);

  // Conflicts leave the active package untouched.
  const exists_ = await install(foreign, null);
  assert.equal(exists_.outcome, "conflict");
  assert.equal(exists_.conflict_reason, "target_exists");
  assert.equal(exists_.observed_digest, first.digest);
  const stale = await install(second, foreign.digest);
  assert.equal(stale.outcome, "conflict");
  assert.equal(stale.conflict_reason, "base_changed");
  assert.equal(stale.observed_digest, first.digest);
  assert.equal(activeText(), first.contents.toString().trim());

  // Writers block an install and release the slot for foreground work.
  const started = await bash(
    port,
    status.execution_id,
    "sleep 60 >/dev/null 2>&1 </dev/null & echo $! > skill-background.pid",
  );
  assert.equal(started.structuredContent.exit_code, 0);
  const background = await install(second, first.digest);
  assert.equal(background.outcome, "blocked");
  assert.equal(background.blocked_reason, "background_task_running");
  assert.match(background.blocked_subject_id, /^bash:[0-9]+$/);
  assert.equal(background.observed_digest, null);
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
  const managed = await install(second, first.digest);
  assert.equal(managed.outcome, "blocked");
  assert.equal(managed.blocked_reason, "managed_call_in_flight");
  assert.equal(managed.blocked_subject_id, "managed:learning");
  const stoppedManaged = await bash(
    port,
    status.execution_id,
    `kill ${managedPid}`,
  );
  assert.notEqual(
    stoppedManaged.structuredContent.exit_code,
    0,
    "UID 1000 must not signal the MCP UID",
  );
  docker(
    "exec",
    "--user",
    "2000:1000",
    runtime,
    "sh",
    "-c",
    'kill "$1"',
    "fixture",
    String(managedPid),
  );

  // Learning never waits for a running foreground call.
  const foreground = bash(port, status.execution_id, "sleep 3", 10_000);
  await new Promise((done) => setTimeout(done, 700));
  const busyInstall = await install(second, first.digest);
  assert.equal(busyInstall.outcome, "blocked");
  assert.equal(busyInstall.blocked_reason, "foreground_running");
  assert.equal(busyInstall.observed_digest, null);
  assert.equal(busyInstall.blocked_subject_id, undefined);
  const busyDigest = await digest();
  assert.equal(busyDigest.outcome, "blocked");
  assert.equal(busyDigest.blocked_reason, "foreground_running");
  assert.equal((await foreground).structuredContent.exit_code, 0);

  let updated;
  for (let attempt = 0; attempt < 30; attempt++) {
    updated = await install(second, first.digest);
    if (updated.outcome !== "blocked") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(updated.outcome, "applied", JSON.stringify(updated));
  assert.equal(updated.observed_digest, second.digest);
  assert.equal(activeText(), second.contents.toString().trim());
  assert.equal(exists(staging), false);

  // Foreground work preempts an install held after its rename; the resend
  // settles from the active bytes without a second rename.
  docker(
    "exec",
    "--user",
    "1000:1000",
    runtime,
    "sh",
    "-c",
    `mkdir -p ${gate} && touch ${gate}/hold`,
  );
  const held = install(third, second.digest);
  await waitFor(() => exists(`${gate}/entered`), "install to reach the gate");
  const preemptStarted = Date.now();
  const served = await bash(port, status.execution_id, "echo served");
  const preemptMs = Date.now() - preemptStarted;
  assert.equal(served.structuredContent.exit_code, 0);
  assert.equal(served.structuredContent.stdout.trim(), "served");
  assert(preemptMs < 2_500, `foreground waited ${preemptMs} ms for learning`);
  const preempted = await held;
  assert.deepEqual(keys(preempted), [
    "action",
    "execution_id",
    "observed_digest",
    "outcome",
    "request_id",
  ]);
  assert.equal(preempted.outcome, "preempted");
  assert.equal(preempted.observed_digest, null);
  assert.equal(activeText(), third.contents.toString().trim());
  docker("exec", "--user", "1000:1000", runtime, "rm", "-r", gate);
  const preemptedInode = inode();
  const settled = await install(third, second.digest);
  assert.equal(settled.outcome, "applied");
  assert.equal(settled.observed_digest, third.digest);
  assert.equal(inode(), preemptedInode);

  // Runtime startup removes staging left by an interrupted install.
  docker(
    "exec",
    "--user",
    "1000:1000",
    runtime,
    "sh",
    "-c",
    `mkdir -p ${staging}/install/package && echo interrupted > ${staging}/install/package/SKILL.md`,
  );
  docker("restart", runtime);
  port = portOf();
  const restarted = await ready(port);
  assert.notEqual(restarted.execution_id, status.execution_id);
  status = restarted;
  assert.equal(exists(staging), false, "startup must remove install staging");
  assert.equal((await digest()).observed_digest, third.digest);
  console.log(
    "Skill install/digest HTTP → UID 1000 executor → atomic create/exchange, resend, conflicts, writer and foreground blocking, post-rename preemption and startup staging cleanup: passed",
  );
} finally {
  cleanup();
}
