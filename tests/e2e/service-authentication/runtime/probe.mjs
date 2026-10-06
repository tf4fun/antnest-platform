import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { crc32 } from "node:zlib";

const input = JSON.parse(readFileSync("/fixture/input.json", "utf8"));
const options = JSON.parse(process.argv[3] ?? "{}");
const base = input.endpoint;
const serviceHeader = "Antnest-Service-Authorization";
let checks = 0;
const digest = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

function request(path, { method = "GET", token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, base),
      {
        method,
        headers: {
          ...(token ? { [serviceHeader]: "Bearer " + token } : {}),
          ...headers,
        },
        timeout: 10000,
        agent: false,
      },
      (response) => {
        const parts = [];
        response.on("data", (part) => parts.push(part));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            raw: Buffer.concat(parts).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("probe request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function expect(response, status, label, code) {
  assert.equal(response.status, status, label);
  if (code) assert.equal(JSON.parse(response.raw).code, code, label);
  for (const token of Object.values(input.tokens))
    assert(
      !response.raw.includes(token),
      "response exposed an instance credential",
    );
  checks++;
}

async function status() {
  const response = await request("/status", { token: input.tokens.rc });
  expect(response, 200, "authenticated full status");
  const value = JSON.parse(response.raw);
  assert.equal(value.agent_id, input.agent);
  assert.equal(value.generation, 1);
  assert.equal(value.status, "ready");
  assert.deepEqual(value.test_features, []);
  assert.match(value.execution_id, /^[0-9a-f-]{36}$/);
  checks++;
  return value;
}

async function ready() {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await request("/status/live");
      if (response.status === 200) return await status();
    } catch {
      /* bootstrap not complete */
    }
    await delay(100);
  }
  throw new Error("native Runtime did not become ready");
}

async function matrix() {
  const current = await status();
  for (const path of [
    "/status",
    "/mcp",
    "/mcp/session",
    "/internal/skill-maintenance/prepare",
    "/internal/skill-temporary/install",
  ]) {
    for (const method of ["GET", "POST", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await request(path, {
        method,
        headers: {
          Authorization: "Bearer unrelated-user-authority",
          "Antnest-Caller-Context": "unsigned-context",
          "X-Antnest-Expected-Execution-ID": current.execution_id,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(
        response,
        401,
        "anonymous native mount " + method + " " + path,
        method === "HEAD" ? undefined : "runtime_unauthorized",
      );
      assert.equal(
        response.headers["www-authenticate"],
        'Bearer realm="antnest-service"',
      );
      assert(!response.raw.includes(input.agent));
      checks++;
    }
  }
  for (const token of [input.tokens.wrong, input.tokens.otherInstance]) {
    expect(
      await request("/status", { token }),
      401,
      "unknown/other-instance token",
      "runtime_unauthorized",
    );
  }
  for (const authorization of [
    "Bearer " + input.tokens.acp + "=",
    "Bearer  " + input.tokens.acp,
    "Basic " + input.tokens.acp,
    "Bearer " + input.tokens.acp + ", Bearer " + input.tokens.acp,
    ["Bearer " + input.tokens.acp, "Bearer " + input.tokens.acp],
  ]) {
    expect(
      await request("/mcp", {
        method: "POST",
        headers: {
          [serviceHeader]: authorization,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      401,
      "malformed/duplicate credential",
      "runtime_unauthorized",
    );
  }
  for (const path of [
    "/mcp",
    "/mcp/session",
    "/internal/skill-maintenance/prepare",
    "/internal/skill-temporary/install",
  ]) {
    expect(
      await request(path, {
        method: "POST",
        token: input.tokens.rc,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      403,
      "RC cannot execute",
      "caller_not_allowed",
    );
  }
  for (const path of [
    "/mcp",
    "/internal/skill-maintenance/check",
    "/internal/skill-maintenance/commit",
    "/internal/skill-maintenance/observe",
    "/internal/skill-maintenance/cancel",
    "/internal/skill-maintenance/release",
    "/internal/skill-temporary/release",
  ]) {
    for (const media of [
      undefined,
      "text/plain",
      "application/json; charset=latin1",
      ["application/json", "application/json"],
    ]) {
      expect(
        await request(path, {
          method: "POST",
          token: input.tokens.acp,
          headers: media ? { "Content-Type": media } : {},
          body: "{}",
        }),
        415,
        "JSON media type",
        "unsupported_media_type",
      );
    }
    for (const body of [
      '{"name":1,"name":2}',
      '{"nested":{"x":1,"x":2}}',
      '{"x":1,"\\u0078":2}',
      "{} {}",
      Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]),
    ]) {
      expect(
        await request(path, {
          method: "POST",
          token: input.tokens.acp,
          headers: { "Content-Type": "application/json" },
          body,
        }),
        400,
        "strict UTF-8 unique JSON",
        "invalid_request",
      );
    }
  }
  for (const host of [
    "evil.example:8093",
    "0.0.0.0:8093",
    "localhost:1",
    "antnest-runtime-unrelated:8093",
    "localhost:8093, evil.example:8093",
  ]) {
    expect(
      await request("/status", {
        token: input.tokens.rc,
        headers: { Host: host },
      }),
      403,
      "host policy",
      "host_not_allowed",
    );
  }
  expect(
    await request("/status", { token: input.tokens.acp }),
    200,
    "ACP full status",
  );
  const live = await request("/status/live");
  expect(live, 200, "anonymous reduced status");
  assert.deepEqual(JSON.parse(live.raw), { status: "ready" });
  checks++;
  const head = await request("/status/live", { method: "HEAD" });
  expect(head, 200, "HEAD reduced status");
  assert.equal(head.raw, "");
  expect(
    await request("/status/live", { method: "POST" }),
    401,
    "no health mutation bypass",
    "runtime_unauthorized",
  );
  for (const host of ["127.0.0.1:8093", "localhost:8093", "[::1]:8093"]) {
    expect(
      await request("/status", {
        token: input.tokens.rc,
        headers: { Host: host },
      }),
      200,
      "exact loopback Host",
    );
  }
  // Credential verification supplements the native execution fence.
  for (const execution of [undefined, "stale-execution"]) {
    const response = await request("/mcp", {
      method: "POST",
      token: input.tokens.acp,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "MCP-Method": "tools/list",
        ...(execution ? { "X-Antnest-Expected-Execution-ID": execution } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(response, 409, "retained execution fence");
  }
  if (options.previousExecution) {
    assert.notEqual(current.execution_id, options.previousExecution);
    checks++;
    expect(
      await request("/mcp", {
        method: "POST",
        token: input.tokens.acp,
        headers: {
          "Content-Type": "application/json",
          "X-Antnest-Expected-Execution-ID": options.previousExecution,
        },
        body: "{}",
      }),
      409,
      "restart keeps authority but retires execution fence",
    );
  }
  return current;
}

async function withSdk(work) {
  const { Client, StreamableHTTPClientTransport } =
    await import("/node_modules/@modelcontextprotocol/client/dist/index.mjs");
  const current = await status();
  const client = new Client(
    { name: "runtime-owning-gate", version: "1" },
    {
      enforceStrictCapabilities: true,
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", base), {
    requestInit: {
      headers: {
        [serviceHeader]: "Bearer " + input.tokens.acp,
        "X-Antnest-Expected-Execution-ID": current.execution_id,
      },
    },
    fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
    reconnectionOptions: { maxRetries: 0 },
    onInsufficientScope: "throw",
  });
  try {
    await client.connect(transport, { signal: AbortSignal.timeout(15000) });
    checks++;
    return await work(client, current);
  } finally {
    await client.close();
  }
}

async function sdk() {
  return withSdk(async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "bash",
      "edit",
      "read",
      "write",
    ]);
    checks++;
    const call = async (name, args) => {
      const result = await client.callTool(
        { name, arguments: args },
        { signal: AbortSignal.timeout(20000) },
      );
      assert(!result.isError, "native tool " + name + " failed");
      for (const token of Object.values(input.tokens))
        assert(!JSON.stringify(result).includes(token));
      checks++;
      return result;
    };
    await call("write", {
      path: "auth-check.txt",
      content: "native auth write",
    });
    const read = await call("read", { path: "auth-check.txt" });
    assert(JSON.stringify(read).includes("native auth write"));
    await call("edit", {
      path: "auth-check.txt",
      old_string: "write",
      new_string: "edit",
    });
    const bash = await call("bash", {
      command:
        'python3 -c \'import os; assert os.getuid() == 1000; assert not os.access("/run/antnest-auth/callers.json", os.R_OK); assert not any(k.startswith("ANTNEST_SERVICE_AUTH_") for k in os.environ); assert "ANTNEST_RUNTIME_SPEC" not in os.environ; print("executor-auth-boundary-ok")\'',
      working_dir: ".",
      env: [],
      timeout_ms: 5000,
    });
    assert(JSON.stringify(bash).includes("executor-auth-boundary-ok"));
    const resource = await client.readResource(
      { uri: "antnest://runtime/info" },
      { cacheMode: "refresh" },
    );
    const info = JSON.parse(resource.contents[0].text);
    assert.equal(info.environment.workspace, "/workspace");
    assert(!JSON.stringify(info).includes("receiver_digest"));
    checks++;
  });
}

async function managedCaches() {
  return withSdk(async (client) => {
    const call = async (name, args) => {
      const result = await client.callTool(
        { name, arguments: args },
        { signal: AbortSignal.timeout(20000) },
      );
      assert(!result.isError, "managed cache probe failed");
      assert(
        !JSON.stringify(result).includes("disk-cache-canary"),
        "cache contents leaked into tool output",
      );
      checks++;
      return result;
    };
    const first = (
      await call("mcp__alpha__echo", { value: "disk-alpha", cache_probe: true })
    ).structuredContent;
    const other = (
      await call("mcp__zeta__echo", {
        value: "disk-zeta",
        cache_probe: true,
        probe_paths: first.cache_paths,
      })
    ).structuredContent;
    assert.deepEqual(
      other.peer_cache_readable,
      first.cache_paths.map(() => false),
      "another MCP can read cached credentials",
    );
    assert.equal(first.uid, 2000);
    assert.equal(other.uid, 2001);
    for (const server of [first, other]) {
      assert.equal(server.cache_paths.length, 5);
      assert.equal(server.home, "/run/antnest-mcp-home/" + server.uid);
      assert.equal(server.cwd, "/workspace");
      assert.equal(server.gid, 1000);
      assert.equal(server.cache_owned_and_readable, true);
      assert.equal(server.cache_executable_ok, true);
      assert.deepEqual(
        server.cache_modes,
        server.cache_paths.map(() => 0o600),
      );
      checks += 6;
    }
    const peers = (
      await call("mcp__alpha__echo", {
        value: "disk-alpha-again",
        cache_probe: true,
        probe_paths: other.cache_paths,
      })
    ).structuredContent;
    assert.deepEqual(
      peers.peer_cache_readable,
      other.cache_paths.map(() => false),
    );
    const bash = await call("bash", {
      command: `python3 - <<'PY'
import os
assert os.getuid() == 1000 and os.getgid() == 1000
for path in ${JSON.stringify([...first.cache_paths, ...other.cache_paths])}:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except PermissionError:
        continue
    os.close(fd)
    raise AssertionError('Bash can read MCP cached credentials')
print('MCP_PRIVATE_CACHES_OK')
PY`,
      working_dir: ".",
      env: [],
      timeout_ms: 5000,
    });
    assert(JSON.stringify(bash).includes("MCP_PRIVATE_CACHES_OK"));
    checks += 2;
  });
}

function archive() {
  const path = Buffer.from("SKILL.md");
  const contents = Buffer.from(
    "---\nname: auth-learning\ndescription: Native authentication learning check\n---\nRepeat the verified file checks.\n",
  );
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(contents), 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(path.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(contents), 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(path.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + path.length, 12);
  end.writeUInt32LE(local.length + path.length + contents.length, 16);
  const bytes = Buffer.concat([local, path, contents, central, path, end]);
  const pathSize = Buffer.alloc(4),
    size = Buffer.alloc(8);
  pathSize.writeUInt32BE(path.length);
  size.writeBigUInt64BE(BigInt(contents.length));
  return {
    bytes,
    artifact_digest: digest(bytes),
    content_digest: digest(
      Buffer.concat([
        Buffer.from("antnest-skill-manifest-v1\0"),
        pathSize,
        path,
        size,
        createHash("sha256").update(contents).digest(),
        Buffer.from([0]),
      ]),
    ),
  };
}

function multipart(metadata, artifact) {
  return Buffer.concat([
    Buffer.from(
      '--auth-skill\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n',
    ),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(
      '\r\n--auth-skill\r\nContent-Disposition: form-data; name="artifact"\r\n\r\n',
    ),
    artifact,
    Buffer.from("\r\n--auth-skill--\r\n"),
  ]);
}

function ticket(
  body,
  execution,
  action,
  requestId,
  jobId = "auth-learning-job",
) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({
      version: 1,
      algorithm: "Ed25519",
      kid: "auth-key",
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      organization_id: "auth-org",
      agent_id: input.agent,
      generation: 1,
      execution_id: execution,
      job_id: jobId,
      action,
      request_id: requestId,
      body_sha256: digest(body),
      issued_at: now,
      expires_at: now + 60,
    }),
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from("antnest-skill-maintenance-v1\n" + header + "." + payload),
    createPrivateKey(input.signing_key),
  ).toString("base64url");
  return "AntnestMaintenance " + header + "." + payload + "." + signature;
}

async function skills() {
  const current = await status(),
    pkg = archive();
  const prepareMeta = {
    action: "prepare",
    request_id: "prepare-auth",
    job_id: "auth-learning-job",
    generation: 1,
    candidate_id: "auth-candidate",
    package_path: ".antnest/skills/auth-learning",
    expected_base_digest: null,
    target_digest: pkg.content_digest,
    artifact_digest: pkg.artifact_digest,
    package_rules_version: 1,
  };
  const preparedBody = multipart(prepareMeta, pkg.bytes);
  const uploadHeaders = {
    "Content-Type": "multipart/form-data; boundary=auth-skill",
    "X-Antnest-Expected-Execution-ID": current.execution_id,
  };
  const signedPrepare = ticket(
    preparedBody,
    current.execution_id,
    "prepare",
    "prepare-auth",
  );
  expect(
    await request("/internal/skill-maintenance/prepare", {
      method: "POST",
      headers: { ...uploadHeaders, Authorization: signedPrepare },
      body: preparedBody,
    }),
    401,
    "ticket without workload cannot prepare",
    "runtime_unauthorized",
  );
  const noTicket = await request("/internal/skill-maintenance/prepare", {
    method: "POST",
    token: input.tokens.acp,
    headers: uploadHeaders,
    body: preparedBody,
  });
  expect(noTicket, 401, "workload without ticket cannot prepare");
  assert.equal(JSON.parse(noTicket.raw).error.code, "maintenance_unauthorized");
  const prepared = await request("/internal/skill-maintenance/prepare", {
    method: "POST",
    token: input.tokens.acp,
    headers: { ...uploadHeaders, Authorization: signedPrepare },
    body: preparedBody,
  });
  expect(prepared, 200, "native multipart learning preparation");
  assert.equal(JSON.parse(prepared.raw).outcome, "prepared");
  checks++;
  const control = async (
    action,
    metadata,
    path = "/internal/skill-maintenance/",
    jobId,
  ) => {
    const body = Buffer.from(JSON.stringify(metadata));
    const response = await request(path + action, {
      method: "POST",
      token: input.tokens.acp,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Antnest-Expected-Execution-ID": current.execution_id,
        Authorization: ticket(
          body,
          current.execution_id,
          metadata.action,
          metadata.request_id,
          jobId,
        ),
      },
      body,
    });
    expect(response, 200, "native signed Skill control " + action);
    return JSON.parse(response.raw);
  };
  const checked = await control("check", {
    ...prepareMeta,
    action: "check",
    request_id: "check-auth",
    expected_base_digest: undefined,
    artifact_digest: undefined,
  });
  assert.equal(checked.outcome, "checked");
  const committed = await control("commit", {
    action: "commit",
    request_id: "commit-auth",
    job_id: "auth-learning-job",
    generation: 1,
    candidate_id: "auth-candidate",
    package_path: prepareMeta.package_path,
    expected_base_digest: null,
    target_digest: pkg.content_digest,
  });
  assert.equal(committed.outcome, "applied");
  checks += 2;
  await withSdk(async (client) => {
    const resource = await client.readResource(
      { uri: "antnest://runtime/info" },
      { cacheMode: "refresh" },
    );
    const info = JSON.parse(resource.contents[0].text);
    assert(
      info.skills.some(
        (skill) =>
          skill.source === "personal" && skill.name === "auth-learning",
      ),
    );
    checks++;
  });
  const temporaryMeta = {
    action: "temporary_install",
    request_id: "install-auth",
    job_id: "auth-temporary-run",
    generation: 1,
    content_digest: pkg.content_digest,
    artifact_digest: pkg.artifact_digest,
    package_rules_version: 1,
  };
  const temporaryBody = multipart(temporaryMeta, pkg.bytes);
  const installed = await request("/internal/skill-temporary/install", {
    method: "POST",
    token: input.tokens.acp,
    headers: {
      ...uploadHeaders,
      Authorization: ticket(
        temporaryBody,
        current.execution_id,
        "temporary_install",
        "install-auth",
        "auth-temporary-run",
      ),
    },
    body: temporaryBody,
  });
  expect(installed, 200, "native multipart temporary installation");
  assert.equal(JSON.parse(installed.raw).outcome, "installed");
  assert.equal(installed.headers["cache-control"], "no-store");
  const released = await control(
    "release",
    {
      action: "temporary_release",
      request_id: "release-auth",
      job_id: "auth-temporary-run",
      generation: 1,
    },
    "/internal/skill-temporary/",
    "auth-temporary-run",
  );
  assert.equal(released.outcome, "released");
  checks += 2;
}

try {
  let current;
  switch (process.argv[2]) {
    case "ready":
      current = await ready();
      break;
    case "matrix":
      current = await matrix();
      break;
    case "sdk":
      await sdk();
      break;
    case "managed-caches":
      await managedCaches();
      break;
    case "skills":
      await skills();
      break;
    default:
      throw new Error("unknown native Runtime probe");
  }
  console.log(
    JSON.stringify({
      checks,
      ...(current ? { execution_id: current.execution_id } : {}),
    }),
  );
} catch (error) {
  let message = String(error.message ?? error.name);
  for (const token of [...Object.values(input.tokens), input.signing_key])
    message = message.replaceAll(token, "[credential omitted]");
  console.error("Native Runtime probe failed: " + message.slice(0, 2000));
  process.exitCode = 1;
}
