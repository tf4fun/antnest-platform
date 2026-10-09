import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import {
  chmodSync,
  chownSync,
  existsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

const socketPath = "/proxy/docker.sock";
const upstreamSocket = "/var/run/docker.sock";
const scope = process.env.ANTNEST_RUNTIME_CONTROLLER_SCOPE;
let armed, hit;

export function creationTarget(path, body, expected) {
  const url = new URL(path, "http://docker");
  const match = /^\/(v[0-9.]+)\/containers\/create$/.exec(url.pathname);
  if (
    !match ||
    url.searchParams.get("name") !== `antnest-runtime-${expected.agent_id}`
  )
    return null;
  const spec = JSON.parse(body);
  const mounts = spec.HostConfig?.Mounts ?? [];
  const skill = mounts.find((mount) => mount.Target === "/skills");
  if (
    !skill ||
    skill.Type !== "volume" ||
    !skill.ReadOnly ||
    !skill.VolumeOptions?.NoCopy ||
    !/^antnest-skills-[0-9a-f]{32}-m[1-9][0-9]*$/.test(skill.Source)
  )
    return null;
  return { version: match[1], volume: skill.Source };
}

export function initializationTarget(path, body) {
  const name = new URL(path, "http://docker").searchParams.get("name") ?? "";
  const match = /^antnest-runtime-(agent_[0-9a-f]{32})$/.exec(name);
  if (!match) return null;
  const target = creationTarget(path, body, { agent_id: match[1] });
  return target ? { ...target, agent_id: match[1] } : null;
}

export function startTarget(path, inspected, expected) {
  const match = /^\/(v[0-9.]+)\/containers\/([a-f0-9]{64})\/start$/.exec(
    new URL(path, "http://docker").pathname,
  );
  const skill = inspected.Mounts?.find(
    (mount) =>
      mount.Type === "volume" &&
      mount.Destination === "/skills" &&
      !mount.RW &&
      /^antnest-skills-[0-9a-f]{32}-m[1-9][0-9]*$/.test(mount.Name),
  );
  if (
    !match ||
    inspected.Id !== match[2] ||
    inspected.State?.Status !== "created" ||
    inspected.State?.Running ||
    inspected.Config?.Labels?.["io.antnest.managed"] !== "runtime" ||
    inspected.Config.Labels["io.antnest.runtime-controller-scope"] !==
      expected.scope ||
    inspected.Config.Labels["io.antnest.agent-id"] !== expected.agent_id ||
    !skill ||
    (expected.volume && skill.Name !== expected.volume)
  )
    return null;
  return { version: match[1], id: match[2], volume: skill.Name };
}

function readBody(request, limit = 2 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Docker request exceeds proxy limit"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function dockerCall(method, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath: upstreamSocket, method, path },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function forward(incoming, outgoing, body) {
  const started = Date.now();
  const path = incoming.url?.split("?")[0];
  console.log(
    JSON.stringify({
      event: "docker_forward_start",
      method: incoming.method,
      path,
    }),
  );
  outgoing.once("finish", () =>
    console.log(
      JSON.stringify({
        event: "docker_forward_finish",
        method: incoming.method,
        path,
        status: outgoing.statusCode,
        duration_ms: Date.now() - started,
      }),
    ),
  );
  const request = httpRequest(
    {
      socketPath: upstreamSocket,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      outgoing.flushHeaders();
      response.pipe(outgoing);
    },
  );
  request.on("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(error.message);
  });
  if (body) request.end(body);
  else incoming.pipe(request);
}

function forwardAndDropResponse(
  incoming,
  outgoing,
  body,
  expectedStatus,
  receiptField,
) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: upstreamSocket,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode !== expectedStatus) {
            reject(
              new Error(`Docker mutation returned ${response.statusCode}`),
            );
            return;
          }
          hit[receiptField] = true;
          writeFileSync("/proxy/race.json", JSON.stringify(hit), {
            mode: 0o600,
          });
          // Docker created the candidate, but RC receives an EOF and must
          // reconcile by inspecting the exact container rather than assuming success.
          outgoing.destroy();
          resolve();
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function intercept(incoming, outgoing) {
  if (
    (hit?.create_response_dropped || hit?.start_response_dropped) &&
    incoming.method === "GET" &&
    new URL(incoming.url, "http://docker").pathname.endsWith(
      `/containers/antnest-runtime-${hit.agent_id}/json`,
    )
  ) {
    hit.recovery_inspect_seen = true;
    writeFileSync("/proxy/race.json", JSON.stringify(hit), { mode: 0o600 });
  }
  if (armed?.mode === "start_response_loss") {
    const path = new URL(incoming.url, "http://docker").pathname;
    const match =
      incoming.method === "POST"
        ? /^\/(v[0-9.]+)\/containers\/([a-f0-9]{64})\/start$/.exec(path)
        : null;
    if (!match) {
      forward(incoming, outgoing);
      return;
    }
    const inspected = await dockerCall(
      "GET",
      `/${match[1]}/containers/${match[2]}/json`,
    );
    assert.equal(inspected.status, 200);
    const candidate = JSON.parse(inspected.body);
    const target = startTarget(incoming.url, candidate, armed);
    if (!target) {
      forward(incoming, outgoing);
      return;
    }
    const volume = await dockerCall(
      "GET",
      `/${target.version}/volumes/${encodeURIComponent(target.volume)}`,
    );
    assert.equal(volume.status, 200);
    const labels = JSON.parse(volume.body).Labels;
    assert.equal(labels?.["io.antnest.managed"], "skill-set");
    assert.equal(labels?.["io.antnest.runtime-controller-scope"], scope);
    assert.equal(labels?.["io.antnest.agent-id"], armed.agent_id);
    assert.equal(
      labels?.["io.antnest.skill-set-digest"],
      armed.skill_set_digest,
    );
    hit = {
      scope,
      agent_id: armed.agent_id,
      skill_set_digest: armed.skill_set_digest,
      volume: target.volume,
      container_id: target.id,
      start_response_dropped: false,
      recovery_inspect_seen: false,
    };
    armed = undefined;
    writeFileSync("/proxy/race.json", JSON.stringify(hit), { mode: 0o600 });
    await forwardAndDropResponse(
      incoming,
      outgoing,
      undefined,
      204,
      "start_response_dropped",
    );
    return;
  }
  if (
    incoming.method !== "POST" ||
    !armed ||
    !/\/containers\/create\?/.test(incoming.url ?? "")
  ) {
    forward(incoming, outgoing);
    return;
  }
  const body = await readBody(incoming);
  const target =
    armed.mode === "initialize_race"
      ? initializationTarget(incoming.url, body)
      : creationTarget(incoming.url, body, armed);
  if (!target) {
    forward(incoming, outgoing, body);
    return;
  }
  const inspect = await dockerCall(
    "GET",
    `/${target.version}/volumes/${encodeURIComponent(target.volume)}`,
  );
  assert.equal(
    inspect.status,
    200,
    "prepared target volume disappeared before race injection",
  );
  const volume = JSON.parse(inspect.body);
  assert.equal(volume.Name, target.volume);
  assert.equal(volume.Labels?.["io.antnest.managed"], "skill-set");
  assert.equal(volume.Labels?.["io.antnest.runtime-controller-scope"], scope);
  assert.equal(
    volume.Labels?.["io.antnest.agent-id"],
    target.agent_id ?? armed.agent_id,
  );
  assert.equal(
    volume.Labels?.["io.antnest.skill-set-digest"],
    armed.skill_set_digest,
  );
  const removed = await dockerCall(
    "DELETE",
    `/${target.version}/volumes/${encodeURIComponent(target.volume)}`,
  );
  assert.equal(
    removed.status,
    204,
    "target volume must be unmounted before Docker create",
  );
  const dropCreateResponse = armed.drop_create_response === true;
  hit = {
    scope,
    agent_id: target.agent_id ?? armed.agent_id,
    skill_set_digest: armed.skill_set_digest,
    volume: target.volume,
    deleted_before_create: true,
    create_response_dropped: false,
    recovery_inspect_seen: false,
  };
  armed = undefined;
  writeFileSync("/proxy/race.json", JSON.stringify(hit), { mode: 0o600 });
  if (dropCreateResponse)
    await forwardAndDropResponse(
      incoming,
      outgoing,
      body,
      201,
      "create_response_dropped",
    );
  else forward(incoming, outgoing, body);
}

export function startProxy() {
  assert(scope && /^[a-z0-9-]+$/.test(scope));
  const socketGid = process.env.ANTNEST_DOCKER_SOCKET_GID;
  assert(
    /^(?:0|[1-9][0-9]*)$/u.test(socketGid) && Number(socketGid) <= 4294967294,
    "ANTNEST_DOCKER_SOCKET_GID is required",
  );
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const dockerServer = createServer((incoming, outgoing) => {
    intercept(incoming, outgoing).catch((error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(error.message);
    });
  });
  dockerServer.listen(socketPath, () => {
    chownSync(socketPath, -1, Number(socketGid));
    chmodSync(socketPath, 0o660);
  });
  const control = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method === "GET" && incoming.url === "/status") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({
            ready: true,
            armed: Boolean(armed),
            hit: hit ?? null,
          }),
        );
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/arm") {
        assert(!armed && !hit, "race injection is single use");
        const value = JSON.parse(await readBody(incoming, 4096));
        if (value.mode === "initialize_race")
          assert.equal(value.agent_id, undefined);
        else assert(/^agent_[0-9a-f]{32}$/.test(value.agent_id));
        assert(/^sha256:[0-9a-f]{64}$/.test(value.skill_set_digest));
        if (value.mode === "start_response_loss") {
          assert(value.scope === undefined || value.scope === scope);
        } else {
          assert(["mount_race", "initialize_race"].includes(value.mode));
          assert(typeof value.drop_create_response === "boolean");
        }
        armed = { ...value, scope };
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end();
    } catch (error) {
      outgoing.writeHead(409);
      outgoing.end(error.message);
    }
  });
  control.listen(8081, "0.0.0.0");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startProxy();
